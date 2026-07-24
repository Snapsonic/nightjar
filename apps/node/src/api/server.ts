import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { CameraPublic, go2rtcStreamName, type CameraConfig } from "@nightjar/shared";
import type { CameraManager } from "../cameras/manager.js";
import type { CloudLink } from "../cloud/link.js";
import type { ConfigStore } from "../config/store.js";
import type { IdentityStore } from "../config/identity.js";
import type { Go2rtcSupervisor } from "../go2rtc/supervisor.js";
import type { Logger } from "../log.js";

const AddCameraBody = z.object({
  name: z.string().min(1).max(80),
  rtspUrl: z.string().url(),
  rtspSubUrl: z.string().url().optional(),
  make: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
});

export interface ApiDeps {
  store: ConfigStore;
  identity: IdentityStore;
  cameras: CameraManager;
  go2rtc: Go2rtcSupervisor;
  link: CloudLink;
  version: string;
  log: Logger;
}

function toPublic(camera: CameraConfig, streams: Record<string, unknown> | null) {
  return {
    ...CameraPublic.parse(camera),
    hasSubstream: camera.rtspSubUrl !== undefined,
    online: streams !== null && go2rtcStreamName(camera.id) in streams,
  };
}

/** Local admin/dev API + static UI on 0.0.0.0:${PORT:-8080}. */
export async function startApiServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Raw SDP bodies for the WHEP proxy.
  app.addContentTypeParser("application/sdp", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL("../../ui", import.meta.url)),
  });

  app.get("/api/status", async () => {
    const config = deps.store.get();
    const streams = await deps.go2rtc.streams();
    return {
      nodeId: deps.identity.get().nodeId ?? null,
      nodeName: config.nodeName,
      version: deps.version,
      cloud: deps.link.getState(),
      go2rtcHealthy: streams !== null,
      cameras: config.cameras.map((camera) => toPublic(camera, streams)),
    };
  });

  app.get("/api/cameras", async () => {
    const streams = await deps.go2rtc.streams();
    return deps.cameras.list().map((camera) => toPublic(camera, streams));
  });

  app.post("/api/cameras", async (req, reply) => {
    const parsed = AddCameraBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const camera = await deps.cameras.addCamera(parsed.data);
    return reply.code(201).send(toPublic(camera, await deps.go2rtc.streams()));
  });

  app.delete<{ Params: { id: string } }>("/api/cameras/:id", async (req, reply) => {
    if (!deps.cameras.removeCamera(req.params.id)) {
      return reply.code(404).send({ error: "camera not found" });
    }
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/cameras/:id/probe", async (req, reply) => {
    if (!deps.cameras.get(req.params.id)) {
      return reply.code(404).send({ error: "camera not found" });
    }
    try {
      return await deps.cameras.probeCamera(req.params.id);
    } catch (err) {
      return reply
        .code(502)
        .send({ error: `probe failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  /**
   * Local WHEP proxy so the browser UI never talks to go2rtc (:1984) directly.
   * Forwards the application/sdp offer, returns the application/sdp answer.
   */
  app.post<{ Params: { cameraId: string } }>("/api/whep/:cameraId", async (req, reply) => {
    const camera = deps.cameras.get(req.params.cameraId);
    if (!camera) return reply.code(404).send({ error: "camera not found" });
    if (typeof req.body !== "string" || req.body.length === 0) {
      return reply.code(400).send({ error: "expected an application/sdp offer body" });
    }
    let res: Response;
    try {
      res = await fetch(
        `${deps.go2rtc.apiUrl()}/api/whep?src=${encodeURIComponent(go2rtcStreamName(camera.id))}`,
        {
          method: "POST",
          headers: { "content-type": "application/sdp" },
          body: req.body,
        },
      );
    } catch {
      return reply.code(502).send({ error: "go2rtc unreachable" });
    }
    const answer = await res.text();
    if (!res.ok) {
      return reply.code(502).send({ error: `go2rtc WHEP returned HTTP ${res.status}` });
    }
    return reply.code(201).header("content-type", "application/sdp").send(answer);
  });

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ host: "0.0.0.0", port });
  deps.log.info(`local UI/API listening on http://0.0.0.0:${port}`);
  return app;
}
