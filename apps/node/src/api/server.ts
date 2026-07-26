import { randomUUID } from "node:crypto";
import { createReadStream, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  CameraPublic,
  MAX_ZONES_PER_CAMERA,
  Zone,
  go2rtcStreamName,
  type CameraConfig,
} from "@nightjar/shared";
import type { GdriveBackup } from "../backup/gdrive.js";
import type { CameraManager } from "../cameras/manager.js";
import type { CloudLink } from "../cloud/link.js";
import type { ConfigStore } from "../config/store.js";
import type { IdentityStore } from "../config/identity.js";
import type { NodeDb } from "../db.js";
import type { Go2rtcSupervisor } from "../go2rtc/supervisor.js";
import type { Logger } from "../log.js";
import type { NestBridge } from "../nest/sdm.js";
import { isCaptureLive, type Recorder } from "../recorder/recorder.js";
import { clampExportRange, clipSpans, dayBoundsMs, mergeCoverage } from "../recorder/coverage.js";
import { getPreviewFrame } from "../recorder/preview.js";

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

const ShareLinksBody = z.object({ shareLinks: z.boolean() });

const UpdateZonesBody = z.object({ zones: z.array(Zone).max(MAX_ZONES_PER_CAMERA) });

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
  recorder: Recorder;
  gdrive: GdriveBackup;
  nest: NestBridge;
  version: string;
  log: Logger;
}

function toPublic(
  camera: CameraConfig,
  streams: Record<string, unknown> | null,
  recorder: Recorder,
) {
  // Recording cameras report real capture liveness (segments actually landing
  // in the index); others keep the go2rtc-config heuristic.
  const online =
    camera.enabled && camera.record
      ? isCaptureLive(recorder.lastSegmentAt(camera.id), Date.now())
      : streams !== null && go2rtcStreamName(camera.id) in streams;
  return {
    ...CameraPublic.parse(camera),
    hasSubstream: camera.rtspSubUrl !== undefined,
    online,
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
      cameras: config.cameras.map((camera) => toPublic(camera, streams, deps.recorder)),
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
    return deps.cameras.list().map((camera) => toPublic(camera, streams, deps.recorder));
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
      return reply.code(201).send(toPublic(camera, await deps.go2rtc.streams(), deps.recorder));
    }
    const camera = await deps.cameras.addCamera(input);
    return reply.code(201).send(toPublic(camera, await deps.go2rtc.streams(), deps.recorder));
  });

  app.delete<{ Params: { id: string } }>("/api/cameras/:id", async (req, reply) => {
    if (!deps.cameras.removeCamera(req.params.id)) {
      return reply.code(404).send({ error: "camera not found" });
    }
    return reply.code(204).send();
  });

  /**
   * Local mirror of the realtime update_zones command (LAN editing without the
   * cloud, and testability). Replaces the camera's activity zones; the config
   * change fans out to the motion masks and (when linked) the cloud sync.
   */
  app.post<{ Params: { id: string } }>("/api/cameras/:id/zones", async (req, reply) => {
    const parsed = UpdateZonesBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "expected { zones: Zone[] }" });
    }
    const updated = deps.cameras.updateCamera(req.params.id, { zones: parsed.data.zones });
    if (!updated) return reply.code(404).send({ error: "camera not found" });
    return toPublic(updated, await deps.go2rtc.streams(), deps.recorder);
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

  /**
   * Make backed-up clips link-shareable. Forward-only, like the backup itself:
   * this only affects clips uploaded from now on — already-backed-up clips
   * keep whatever permissions they have.
   */
  app.post("/api/backup/gdrive/share-links", async (req, reply) => {
    const parsed = ShareLinksBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "expected { shareLinks: boolean }" });
    }
    const backup = deps.store.get().backup;
    deps.store.update({
      backup: { ...backup, gdrive: { ...backup.gdrive, shareLinks: parsed.data.shareLinks } },
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

  /* ---------- 24/7 recording timeline ---------- */

  /** Days (node-local YYYY-MM-DD) that have any recorded segments. */
  app.get<{ Params: { cameraId: string } }>(
    "/api/recordings/:cameraId/days",
    async (req) => deps.db.segmentDays(req.params.cameraId),
  );

  /** Merged coverage spans [{startMs,endMs}] for one local-time day. */
  app.get<{ Params: { cameraId: string }; Querystring: { day?: string } }>(
    "/api/recordings/:cameraId/coverage",
    async (req, reply) => {
      const day = req.query.day ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return reply.code(400).send({ error: "expected ?day=YYYY-MM-DD" });
      }
      const bounds = dayBoundsMs(day);
      const rows = deps.db.segmentsBetween(req.params.cameraId, bounds.startMs, bounds.endMs);
      return clipSpans(mergeCoverage(rows, Date.now()), bounds.startMs, bounds.endMs);
    },
  );

  /**
   * Single JPEG preview frame at ?atMs= (bucketed to the minute, disk-cached
   * under <recordings>/.previews). 404 when no recording covers that minute.
   */
  app.get<{ Params: { cameraId: string }; Querystring: { atMs?: string } }>(
    "/api/recordings/:cameraId/preview",
    async (req, reply) => {
      const atMs = Number(req.query.atMs);
      if (!Number.isFinite(atMs) || atMs < 0) {
        return reply.code(400).send({ error: "expected numeric ?atMs=" });
      }
      const jpgPath = await getPreviewFrame(
        {
          recordingsDir: deps.store.get().paths.recordings,
          segmentsBetween: (cameraId, t0Ms, t1Ms) => deps.db.segmentsBetween(cameraId, t0Ms, t1Ms),
          log: deps.log,
        },
        req.params.cameraId,
        atMs,
      );
      if (!jpgPath) {
        return reply.code(404).send({ error: "no recording at that time" });
      }
      let bytes: Buffer;
      try {
        // Small (~320w q7) file; read whole so a pruned-midway file 404s cleanly.
        bytes = readFileSync(jpgPath);
      } catch {
        return reply.code(404).send({ error: "no recording at that time" });
      }
      reply.header("content-type", "image/jpeg");
      // Minute-bucketed frames are immutable once extracted.
      reply.header("cache-control", "private, max-age=300");
      return reply.send(bytes);
    },
  );

  /**
   * Export [fromMs, toMs) as a single mp4 and stream it (inline, with basic
   * single-range support so <video> can seek). The range is clamped to 15
   * minutes; the temp file is deleted once the response stream closes.
   */
  app.get<{ Params: { cameraId: string }; Querystring: { fromMs?: string; toMs?: string } }>(
    "/api/recordings/:cameraId/export",
    async (req, reply) => {
      const range = clampExportRange(Number(req.query.fromMs), Number(req.query.toMs));
      if (!range) {
        return reply.code(400).send({ error: "expected numeric ?fromMs=&toMs= with fromMs < toMs" });
      }
      const cameraId = req.params.cameraId;
      if (deps.recorder.segmentsBetween(cameraId, range.fromMs, range.toMs).length === 0) {
        return reply.code(404).send({ error: "no recordings in that range" });
      }
      const outPath = path.join(
        deps.store.get().paths.recordings,
        ".exports",
        `${cameraId}-${range.fromMs}-${range.toMs}-${randomUUID()}.mp4`,
      );
      try {
        await deps.recorder.exportRange(cameraId, range.fromMs, range.toMs, outPath);
      } catch (err) {
        try {
          unlinkSync(outPath);
        } catch {
          // never created
        }
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("no recorded segments")) {
          return reply.code(404).send({ error: "no recordings in that range" });
        }
        deps.log.warn(`timeline export failed: ${message}`);
        return reply.code(500).send({ error: "export failed" });
      }

      const size = statSync(outPath).size;
      reply.header("content-type", "video/mp4");
      reply.header("accept-ranges", "bytes");
      reply.header(
        "content-disposition",
        `inline; filename="${cameraId}-${range.fromMs}.mp4"`,
      );

      // Single-range support (Safari requires 206 responses to play mp4).
      let start = 0;
      let end = size - 1;
      const rangeHeader = req.headers.range;
      const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;
      if (match && (match[1] !== "" || match[2] !== "")) {
        if (match[1] === "") {
          start = Math.max(0, size - Number(match[2]));
        } else {
          start = Number(match[1]);
          if (match[2] !== "") end = Math.min(end, Number(match[2]));
        }
        if (start > end || start >= size) {
          unlinkSync(outPath);
          return reply
            .code(416)
            .header("content-range", `bytes */${size}`)
            .send({ error: "range not satisfiable" });
        }
        reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`);
      }
      reply.header("content-length", end - start + 1);

      const stream = createReadStream(outPath, { start, end });
      // The temp clip lives exactly as long as this response.
      stream.once("close", () => {
        try {
          unlinkSync(outPath);
        } catch {
          // already gone
        }
      });
      return reply.send(stream);
    },
  );

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
        `${deps.go2rtc.apiUrl()}/api/webrtc?src=${encodeURIComponent(go2rtcStreamName(camera.id))}`,
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
