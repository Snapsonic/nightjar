import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { CameraPublic, go2rtcStreamName, type CameraConfig } from "@nightjar/shared";
import type { GdriveBackup } from "../backup/gdrive.js";
import type { CameraManager } from "../cameras/manager.js";
import type { CloudLink } from "../cloud/link.js";
import type { ConfigStore } from "../config/store.js";
import type { IdentityStore } from "../config/identity.js";
import type { NodeDb } from "../db.js";
import type { Go2rtcSupervisor } from "../go2rtc/supervisor.js";
import type { Logger } from "../log.js";
import type { NestBridge } from "../nest/sdm.js";

const AddCameraBody = z
  .object({
    name: z.string().min(1).max(80),
    source: z.enum(["rtsp", "nest"]).default("rtsp"),
    rtspUrl: z.string().url().optional(),
    rtspSubUrl: z.string().url().optional(),
    nestDeviceId: z.string().min(1).optional(),
    make: z.string().max(80).optional(),
    model: z.string().max(80).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.source === "rtsp" && body.rtspUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rtspUrl"],
        message: "rtspUrl is required for RTSP cameras",
      });
    }
    if (body.source === "nest" && body.nestDeviceId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nestDeviceId"],
        message: "nestDeviceId is required for Nest cameras",
      });
    }
  });

const ToggleBackupBody = z.object({ enabled: z.boolean() });

const NestCredentialsBody = z.object({
  projectId: z.string().min(1).max(200),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(200),
});

const NestCodeBody = z.object({ codeOrUrl: z.string().min(1).max(4000) });

export interface ApiDeps {
  store: ConfigStore;
  identity: IdentityStore;
  cameras: CameraManager;
  go2rtc: Go2rtcSupervisor;
  link: CloudLink;
  db: NodeDb;
  gdrive: GdriveBackup;
  nest: NestBridge;
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

  /** Recent local events (newest first) for the UI event list. */
  app.get("/api/events", async () => {
    return deps.db.recentEvents(50).map((row) => ({
      id: row.id,
      cameraId: row.camera_id,
      kind: row.kind,
      score: row.score,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      clipStatus: row.clip_status,
    }));
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
    const input = { ...parsed.data };
    if (input.source === "nest") {
      const duplicate = deps.cameras
        .list()
        .some((c) => c.nest?.deviceId === input.nestDeviceId);
      if (duplicate) {
        return reply.code(409).send({ error: "that Nest device is already added as a camera" });
      }
      // Capabilities from SDM traits when cheaply available (cached list);
      // ffprobe is skipped — the stream only exists once go2rtc pulls it.
      const capabilities = await deps.nest.deviceCapabilities(input.nestDeviceId as string);
      const nestProtocols = await deps.nest.deviceProtocols(input.nestDeviceId as string);
      const camera = await deps.cameras.addCamera({ ...input, capabilities, nestProtocols });
      return reply.code(201).send(toPublic(camera, await deps.go2rtc.streams()));
    }
    const camera = await deps.cameras.addCamera(input);
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

  /* ---------- "bring your own cloud" backup (Google Drive) ---------- */

  /**
   * Backup status: notConfigured (no OAuth client on this build) |
   * disconnected | connecting {userCode, verificationUrl, expiresAt} |
   * connected {email, folderName, enabled, queued, quota} | error {message}.
   */
  app.get("/api/backup/gdrive", async () => deps.gdrive.getStatus());

  /** Start the OAuth device flow — returns the connecting state to display. */
  app.post("/api/backup/gdrive/connect", async (_req, reply) => {
    const status = await deps.gdrive.startConnect();
    if (status.status === "notConfigured") {
      return reply
        .code(409)
        .send({ error: "Google Drive backup is not configured on this build" });
    }
    return status;
  });

  /** Revoke the Google grant and delete the local token file. */
  app.post("/api/backup/gdrive/disconnect", async () => {
    await deps.gdrive.disconnect();
    return deps.gdrive.getStatus();
  });

  app.post("/api/backup/gdrive/toggle", async (req, reply) => {
    const parsed = ToggleBackupBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "expected { enabled: boolean }" });
    }
    const backup = deps.store.get().backup;
    deps.store.update({
      backup: { ...backup, gdrive: { ...backup.gdrive, enabled: parsed.data.enabled } },
    });
    return deps.gdrive.getStatus();
  });

  /* ---------- Nest camera bridge (Google SDM) ---------- */

  /**
   * Bridge status: notConfigured {missing} (SDM project/OAuth client not yet
   * entered) | disconnected | connected {projectId, devices?} | error {message}.
   */
  app.get("/api/nest", async () => deps.nest.getStatus());

  /** Persist the user's Device Access project id + OAuth web client. */
  app.post("/api/nest/credentials", async (req, reply) => {
    const parsed = NestCredentialsBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "expected { projectId, clientId, clientSecret } (all non-empty)" });
    }
    deps.store.update({ nest: { ...deps.store.get().nest, ...parsed.data } });
    return deps.nest.getStatus();
  });

  /** Consent URL for the manual paste-back OAuth flow. */
  app.get("/api/nest/auth-url", async (_req, reply) => {
    try {
      return { url: deps.nest.buildAuthUrl() };
    } catch (err) {
      return reply
        .code(409)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Exchange the pasted code (or full google.com URL) for tokens. */
  app.post("/api/nest/code", async (req, reply) => {
    const parsed = NestCodeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "expected { codeOrUrl: string }" });
    }
    try {
      await deps.nest.exchangeCode(parsed.data.codeOrUrl);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
    return deps.nest.getStatus();
  });

  /** Live devices.list (cached 60s; ?refresh=1 forces). */
  app.get<{ Querystring: { refresh?: string } }>("/api/nest/devices", async (req, reply) => {
    const status = deps.nest.getStatus();
    if (status.status !== "connected") {
      return reply.code(409).send({ error: `nest is ${status.status}` });
    }
    try {
      const result = await deps.nest.listDevices(req.query.refresh === "1");
      const addedDeviceIds = deps.cameras
        .list()
        .map((c) => c.nest?.deviceId)
        .filter((id): id is string => id !== undefined);
      return { ...result, addedDeviceIds };
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Revoke the Google grant and delete the local token file. */
  app.post("/api/nest/disconnect", async () => {
    await deps.nest.disconnect();
    return deps.nest.getStatus();
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
