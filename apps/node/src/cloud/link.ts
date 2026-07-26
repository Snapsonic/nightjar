import { readFileSync, statfsSync } from "node:fs";
import { z } from "zod";
import { createNightjarClient, type Json, type NightjarClient } from "@nightjar/db";
import {
  NodeRegisterResponse,
  REALTIME_BROADCAST_EVENT,
  RealtimeMessage,
  go2rtcStreamName,
  nodeTopic,
} from "@nightjar/shared";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { CameraManager } from "../cameras/manager.js";
import type { IdentityStore } from "../config/identity.js";
import type { ConfigStore } from "../config/store.js";
import type { NodeDb } from "../db.js";
import type { Go2rtcSupervisor } from "../go2rtc/supervisor.js";
import type { Logger } from "../log.js";
import { isCaptureLive, type Recorder } from "../recorder/recorder.js";
import { clampExportRange, clipSpans, dayBoundsMs, mergeCoverage } from "../recorder/coverage.js";
import { getPreviewFrame, previewBucketMs } from "../recorder/preview.js";
import {
  TIMELINE_BUCKET,
  cleanupTimelineExports,
  exportTimelineClip,
  type TimelineStorage,
} from "./timeline.js";
import path from "node:path";

type WhepOfferMessage = Extract<RealtimeMessage, { type: "whep_offer" }>;
type SnapshotRequestMessage = Extract<RealtimeMessage, { type: "snapshot_request" }>;
type TimelineDaysMessage = Extract<RealtimeMessage, { type: "timeline_days_request" }>;
type TimelineCoverageMessage = Extract<RealtimeMessage, { type: "timeline_coverage_request" }>;
type TimelineExportMessage = Extract<RealtimeMessage, { type: "timeline_export_request" }>;
type TimelinePreviewMessage = Extract<RealtimeMessage, { type: "timeline_preview_request" }>;
type UpdateZonesMessage = Extract<RealtimeMessage, { type: "update_zones_request" }>;
type DiskInfo = Extract<RealtimeMessage, { type: "status_reply" }>["disk"];

const TokenResponse = z.object({
  claimed: z.boolean(),
  accessToken: z.string().optional(),
  expiresAt: z.string().optional(),
});

type ErrorCode = "camera_not_found" | "camera_offline" | "go2rtc_unreachable" | "internal";

class LinkError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** An edge function rejected the node's credentials (HTTP 401). */
class CloudAuthError extends Error {}

/**
 * Module-level go2rtc frame-fetch cooldown: when the last frame attempt for
 * ANY camera failed within the past 10s, snapshot requests make a single
 * attempt instead of the full retry loop — 5 tiles x 4 retries would
 * otherwise herd a dead go2rtc.
 */
let lastFrameFailureAtMs = 0;

interface NodeToken {
  accessToken: string;
  expiresAt: string;
}

export type CloudState =
  | { state: "disabled" }
  | { state: "registering" }
  | { state: "unclaimed"; claimCode: string | null; claimCodeExpiresAt: string | null }
  | { state: "connecting" }
  | { state: "online" }
  | { state: "error"; message: string };

export interface CloudLinkDeps {
  store: ConfigStore;
  identity: IdentityStore;
  cameras: CameraManager;
  go2rtc: Go2rtcSupervisor;
  db: NodeDb;
  recorder: Recorder;
  version: string;
  log: Logger;
}

const TOKEN_POLL_MS = 30_000;
/** Signed-URL TTL for timeline hover previews. */
const PREVIEW_SIGNED_URL_TTL_S = 600;
const HEARTBEAT_MS = 60_000;
const TIMELINE_CLEANUP_MS = 6 * 3_600_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
/** A session that survives this long resets the reconnect backoff. */
const SESSION_STABLE_MS = 30_000;
/** Slow poll while the cloud rejects our credentials (don't hot-loop a 401). */
const AUTH_REJECTED_POLL_MS = 10 * 60_000;
/** Timeout for plain fetches (edge functions, go2rtc). */
const FETCH_TIMEOUT_MS = 5_000;
/** See lastFrameFailureAtMs. */
const FRAME_FAILURE_COOLDOWN_MS = 10_000;

/**
 * Cloud link state machine:
 *   register (once) -> poll node-token until claimed -> session
 * A session = supabase client with the node JWT + private realtime channel
 * `node:{nodeId}` handling browser signaling/commands, plus a heartbeat and
 * camera-row sync. Sessions end on channel failure or shortly before token
 * expiry; the outer loop reconnects with exponential backoff (cap 60s).
 */
export class CloudLink {
  private running = false;
  private loop: Promise<void> | null = null;
  private state: CloudState = { state: "disabled" };
  private claim: { code: string; expiresAt: string } | null = null;
  private client: NightjarClient | null = null;
  private channel: RealtimeChannel | null = null;
  private endSession: ((reason: string) => void) | null = null;
  private readonly wakers = new Set<() => void>();
  private readonly log: Logger;

  constructor(private readonly deps: CloudLinkDeps) {
    this.log = deps.log;
  }

  /* ---------- public surface ---------- */

  getState(): CloudState {
    return this.state;
  }

  getNodeId(): string | null {
    return this.deps.identity.get().nodeId ?? null;
  }

  /** PostgREST/storage client authenticated as the node, when a session is up. */
  getClient(): NightjarClient | null {
    return this.client;
  }

  start(): void {
    if (this.running) return;
    if (!this.settings()) {
      this.state = { state: "disabled" };
      this.log.info("cloud link disabled (no supabase url/key or cloud.enabled=false)");
      return;
    }
    this.running = true;
    this.loop = this.run().catch((err) => {
      this.log.error(`cloud link loop crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const wake of [...this.wakers]) wake();
    this.wakers.clear();
    this.endSession?.("shutdown");
    await this.loop;
    this.loop = null;
  }

  /* ---------- plumbing ---------- */

  private settings(): { url: string; anonKey: string } | null {
    const cloud = this.deps.store.get().cloud;
    if (!cloud.enabled) return null;
    const url = process.env.NIGHTJAR_SUPABASE_URL || cloud.supabaseUrl;
    const anonKey = process.env.NIGHTJAR_SUPABASE_ANON_KEY || cloud.supabaseAnonKey;
    if (!url || !anonKey) return null;
    return { url: url.replace(/\/+$/, ""), anonKey };
  }

  /** Interruptible sleep — resolves early on stop(). */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      timer.unref();
      this.wakers.add(wake);
    });
  }

  private async callFn(name: string, body: unknown): Promise<unknown> {
    const settings = this.settings();
    if (!settings) throw new Error("cloud settings missing");
    const res = await fetch(`${settings.url}/functions/v1/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: settings.anonKey,
        authorization: `Bearer ${settings.anonKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const message = `${name} failed: HTTP ${res.status} ${detail}`.trim();
      // 401 = the cloud rejected our credentials (e.g. node row deleted). A
      // claimed node must NOT re-register (it would orphan itself) — the run
      // loop surfaces this state and slows down instead.
      if (res.status === 401) throw new CloudAuthError(message);
      throw new Error(message);
    }
    return res.json();
  }

  /* ---------- state machine ---------- */

  private async run(): Promise<void> {
    let backoff = BACKOFF_START_MS;
    while (this.running) {
      try {
        await this.ensureRegistered();
        const token = await this.pollUntilClaimed();
        if (!token) return; // stopped
        const sessionStartedAt = Date.now();
        await this.session(token);
        // A session that flapped (died <30s in) must not reset the backoff —
        // that turns e.g. a rejected channel into a 1s reconnect hot-loop.
        if (Date.now() - sessionStartedAt >= SESSION_STABLE_MS) {
          backoff = BACKOFF_START_MS;
        } else if (this.running) {
          this.log.warn(
            `cloud session ended ${Math.round((Date.now() - sessionStartedAt) / 1000)}s after ` +
              `starting — backing off ${Math.round(backoff / 1000)}s`,
          );
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
        }
      } catch (err) {
        if (err instanceof CloudAuthError) {
          this.state = {
            state: "error",
            message: "cloud identity rejected — node may need re-pairing",
          };
          this.log.error(
            `cloud rejected the node's credentials (${err.message}) — ` +
              `retrying in ${Math.round(AUTH_REJECTED_POLL_MS / 60_000)} min; ` +
              `if this persists the node may need re-pairing`,
          );
          await this.sleep(AUTH_REJECTED_POLL_MS);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.state = { state: "error", message };
        this.log.warn(`cloud link error: ${message} — retrying in ${Math.round(backoff / 1000)}s`);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
      }
    }
  }

  private async ensureRegistered(): Promise<void> {
    const identity = this.deps.identity.get();
    if (identity.nodeId) {
      // Restarted while (possibly) unclaimed — reuse the persisted claim code
      // so the UI can still show it.
      if (!this.claim && identity.claimCode && identity.claimCodeExpiresAt) {
        this.claim = { code: identity.claimCode, expiresAt: identity.claimCodeExpiresAt };
      }
      return;
    }
    this.state = { state: "registering" };
    const response = NodeRegisterResponse.parse(
      await this.callFn("node-register", {
        nodeSecret: identity.nodeSecret,
        nodeName: this.deps.store.get().nodeName,
        version: this.deps.version,
      }),
    );
    this.deps.identity.setRegistration(
      response.nodeId,
      response.claimCode,
      response.claimCodeExpiresAt,
    );
    this.claim = { code: response.claimCode, expiresAt: response.claimCodeExpiresAt };
    this.log.info(`registered as node ${response.nodeId}; claim code ${response.claimCode}`);
  }

  /** Poll node-token every 30s until claimed. Returns null if stopped. */
  private async pollUntilClaimed(): Promise<NodeToken | null> {
    while (this.running) {
      const identity = this.deps.identity.get();
      const nodeId = identity.nodeId;
      if (!nodeId) throw new Error("no nodeId after registration");
      const parsed = TokenResponse.parse(
        await this.callFn("node-token", { nodeId, nodeSecret: identity.nodeSecret }),
      );
      if (parsed.claimed && parsed.accessToken && parsed.expiresAt) {
        this.claim = null;
        this.deps.identity.clearClaim();
        return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
      }
      // Unclaimed with no usable code (expired, or lost before persistence
      // existed): re-register with a fresh identity so the UI always has a
      // valid code. The abandoned row is garbage-collected server-side.
      if (!this.claim || Date.parse(this.claim.expiresAt) <= Date.now()) {
        this.log.info("claim code missing or expired — re-registering for a fresh code");
        this.claim = null;
        this.deps.identity.regenerate();
        await this.ensureRegistered();
        continue;
      }
      this.state = {
        state: "unclaimed",
        claimCode: this.claim.code,
        claimCodeExpiresAt: this.claim.expiresAt,
      };
      await this.sleep(TOKEN_POLL_MS);
    }
    return null;
  }

  /** One connected session; resolves when it should be torn down + rebuilt. */
  private async session(token: NodeToken): Promise<void> {
    const settings = this.settings();
    const nodeId = this.deps.identity.get().nodeId;
    if (!settings || !nodeId) throw new Error("cloud settings or nodeId missing");

    this.state = { state: "connecting" };
    const client = createNightjarClient(settings.url, settings.anonKey, token.accessToken);
    client.realtime.setAuth(token.accessToken);
    this.client = client;

    let ended = false;
    let resolveEnded!: () => void;
    const endedPromise = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    const endSession = (reason: string): void => {
      if (ended) return;
      ended = true;
      this.log.info(`cloud session ending: ${reason}`);
      resolveEnded();
    };
    this.endSession = endSession;

    const channel = client.channel(nodeTopic(nodeId), { config: { private: true } });
    this.channel = channel;
    channel.on("broadcast", { event: REALTIME_BROADCAST_EVENT }, (message: { payload?: unknown }) => {
      void this.handleMessage(message.payload);
    });
    channel.subscribe((status) => {
      const s = String(status);
      if (s === "SUBSCRIBED") {
        this.state = { state: "online" };
        this.log.info(`subscribed to ${nodeTopic(nodeId)}`);
      } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
        endSession(`realtime channel ${s}`);
      }
    });

    const beat = async (): Promise<void> => {
      try {
        await this.heartbeat(client, nodeId);
      } catch (err) {
        this.log.warn(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void beat();
    const heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_MS);
    heartbeatTimer.unref();

    // Belt-and-braces: a half-open websocket can leave the channel in a dead
    // state without ever firing CHANNEL_ERROR/CLOSED — recycle the session if
    // the channel is no longer joined.
    const watchdogTimer = setInterval(() => {
      const state = String(channel.state);
      if (state !== "joined" && state !== "joining") {
        endSession(`realtime channel watchdog (state=${state})`);
      }
    }, 120_000);
    watchdogTimer.unref();

    const sync = async (): Promise<void> => {
      try {
        await this.syncCameras(client, nodeId);
      } catch (err) {
        this.log.warn(`camera sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void sync();
    const unsubscribeConfig = this.deps.store.onChange(() => void sync());

    // Prune our own stale timeline exports on session start and every 6h.
    const timelineCleanup = async (): Promise<void> => {
      try {
        const removed = await cleanupTimelineExports(nodeId, this.timelineStorage(client));
        if (removed > 0) this.log.info(`timeline cleanup removed ${removed} stale export(s)`);
      } catch (err) {
        this.log.warn(
          `timeline cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    void timelineCleanup();
    const timelineCleanupTimer = setInterval(() => void timelineCleanup(), TIMELINE_CLEANUP_MS);
    timelineCleanupTimer.unref();

    // Reconnect (fresh token + client) shortly before the token expires.
    const msLeft = Date.parse(token.expiresAt) - Date.now();
    const refreshIn = Math.max(10_000, msLeft - 5 * 60_000);
    const refreshTimer = setTimeout(() => endSession("token refresh"), refreshIn);
    refreshTimer.unref();

    await endedPromise;

    clearInterval(heartbeatTimer);
    clearInterval(watchdogTimer);
    clearInterval(timelineCleanupTimer);
    clearTimeout(refreshTimer);
    unsubscribeConfig();
    this.endSession = null;
    this.channel = null;
    this.client = null;
    try {
      await client.removeChannel(channel);
    } catch {
      // channel may already be gone
    }
    client.realtime.disconnect();
    if (this.running) this.state = { state: "connecting" };
  }

  /* ---------- cloud writes ---------- */

  private async heartbeat(client: NightjarClient, nodeId: string): Promise<void> {
    const config = this.deps.store.get();
    const { error } = await client
      .from("nodes")
      .update({
        status: "online",
        last_seen_at: new Date().toISOString(),
        name: config.nodeName,
        version: this.deps.version,
      })
      .eq("id", nodeId);
    if (error) throw new Error(error.message);
  }

  /** Upsert CameraPublic-shaped rows for our cameras; delete rows we no longer have. */
  private async syncCameras(client: NightjarClient, nodeId: string): Promise<void> {
    const cameras = this.deps.cameras.list();
    const rows = cameras.map((camera) => ({
      id: camera.id,
      node_id: nodeId,
      name: camera.name,
      make: camera.make ?? null,
      model: camera.model ?? null,
      capabilities: JSON.parse(JSON.stringify(camera.capabilities)) as Json,
      zones: JSON.parse(JSON.stringify(camera.zones)) as Json,
      enabled: camera.enabled,
    }));
    if (rows.length > 0) {
      const { error } = await client.from("cameras").upsert(rows, { onConflict: "id" });
      if (error) throw new Error(`upsert cameras: ${error.message}`);
    }
    let deletion = client.from("cameras").delete().eq("node_id", nodeId);
    if (rows.length > 0) {
      deletion = deletion.not("id", "in", `(${cameras.map((c) => c.id).join(",")})`);
    }
    const { error: deleteError } = await deletion;
    if (deleteError) throw new Error(`delete cameras: ${deleteError.message}`);
  }

  /* ---------- incoming messages ---------- */

  private async handleMessage(raw: unknown): Promise<void> {
    const parsed = RealtimeMessage.safeParse(raw);
    if (!parsed.success) {
      this.log.debug("ignoring malformed realtime message");
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "whep_offer":
        await this.replyOrError(message.requestId, () => this.onWhepOffer(message));
        break;
      case "snapshot_request":
        await this.replyOrError(message.requestId, () => this.onSnapshotRequest(message));
        break;
      case "status_request":
        await this.replyOrError(message.requestId, () => this.onStatusRequest(message.requestId));
        break;
      case "timeline_days_request":
        await this.replyOrError(message.requestId, () => this.onTimelineDays(message));
        break;
      case "timeline_coverage_request":
        await this.replyOrError(message.requestId, () => this.onTimelineCoverage(message));
        break;
      case "timeline_export_request":
        await this.replyOrError(message.requestId, () => this.onTimelineExport(message));
        break;
      case "timeline_preview_request":
        await this.replyOrError(message.requestId, () => this.onTimelinePreview(message));
        break;
      case "update_zones_request":
        await this.replyOrError(message.requestId, () => this.onUpdateZones(message));
        break;
      default:
        // Replies (possibly our own echoes) — nothing to do.
        break;
    }
  }

  private async replyOrError(requestId: string, handler: () => Promise<void>): Promise<void> {
    try {
      await handler();
    } catch (err) {
      const code: ErrorCode = err instanceof LinkError ? err.code : "internal";
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`request ${requestId} failed (${code}): ${message}`);
      await this.send({ type: "error", requestId, code, message });
    }
  }

  private async send(payload: RealtimeMessage): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    const result = await channel.send({
      type: "broadcast",
      event: REALTIME_BROADCAST_EVENT,
      payload,
    });
    if (result !== "ok") this.log.warn(`broadcast send returned "${result}"`);
  }

  private async onWhepOffer(message: WhepOfferMessage): Promise<void> {
    const camera = this.deps.cameras.get(message.cameraId);
    if (!camera) throw new LinkError("camera_not_found", `unknown camera ${message.cameraId}`);
    const src = go2rtcStreamName(camera.id, message.sub && camera.rtspSubUrl !== undefined);

    let res: Response;
    try {
      res = await fetch(`${this.deps.go2rtc.apiUrl()}/api/webrtc?src=${encodeURIComponent(src)}`, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: message.sdp,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new LinkError("go2rtc_unreachable", "go2rtc is not responding");
    }
    if (!res.ok) throw new LinkError("camera_offline", `go2rtc WHEP returned HTTP ${res.status}`);

    const sdp = await res.text();
    await this.send({ type: "whep_answer", requestId: message.requestId, sdp });
  }

  private async onSnapshotRequest(message: SnapshotRequestMessage): Promise<void> {
    const camera = this.deps.cameras.get(message.cameraId);
    if (!camera) throw new LinkError("camera_not_found", `unknown camera ${message.cameraId}`);
    const client = this.client;
    const nodeId = this.getNodeId();
    if (!client || !nodeId) throw new LinkError("internal", "cloud session not ready");

    // SDM streams churn routinely, so a snapshot request often lands mid
    // (re)start — retry inside the node (the browser waits 30s anyway) rather
    // than surfacing every warm-up as an error tile.
    const frameUrl = `${this.deps.go2rtc.apiUrl()}/api/frame.jpeg?src=${encodeURIComponent(go2rtcStreamName(camera.id))}`;
    // When a frame fetch for ANY camera just failed, go2rtc is likely down or
    // struggling — make a single attempt instead of herding it with retries.
    const attempts =
      Date.now() - lastFrameFailureAtMs < FRAME_FAILURE_COOLDOWN_MS ? 1 : 4;
    let bytes: ArrayBuffer | null = null;
    let lastFailure = "snapshot unavailable";
    for (let attempt = 0; attempt < attempts && bytes === null; attempt++) {
      if (attempt > 0) await this.sleep(4_000);
      let res: Response;
      try {
        res = await fetch(frameUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch {
        lastFrameFailureAtMs = Date.now();
        throw new LinkError("go2rtc_unreachable", "go2rtc is not responding");
      }
      if (!res.ok) {
        lastFrameFailureAtMs = Date.now();
        lastFailure = `snapshot returned HTTP ${res.status}`;
        continue;
      }
      const body = await res.arrayBuffer();
      if (body.byteLength === 0) {
        // go2rtc can 200 with an empty body while a stream is starting.
        lastFrameFailureAtMs = Date.now();
        lastFailure = "snapshot was empty (stream starting?)";
        continue;
      }
      bytes = body;
    }
    if (bytes === null) throw new LinkError("camera_offline", lastFailure);

    const storagePath = `${nodeId}/snap-${message.cameraId}-${Date.now()}.jpg`;
    const { error: uploadError } = await client.storage
      .from("snapshots")
      // No upsert: the path is timestamped-unique, and storage's upsert path
      // requires an UPDATE policy evaluation that plain inserts don't need.
      .upload(storagePath, bytes, { contentType: "image/jpeg" });
    if (uploadError) throw new LinkError("internal", `snapshot upload: ${uploadError.message}`);

    const { data, error: signError } = await client.storage
      .from("snapshots")
      .createSignedUrl(storagePath, 300);
    if (signError || !data) {
      throw new LinkError("internal", `sign snapshot url: ${signError?.message ?? "no data"}`);
    }
    await this.send({ type: "snapshot_reply", requestId: message.requestId, url: data.signedUrl });
  }

  /* ---------- timeline (24/7 recording playback) ---------- */

  /** Supabase-backed TimelineStorage for the "timeline-exports" bucket. */
  private timelineStorage(client: NightjarClient): TimelineStorage {
    const bucket = client.storage.from(TIMELINE_BUCKET);
    return {
      createSignedUrl: async (objectPath, ttlSec) => {
        const { data, error } = await bucket.createSignedUrl(objectPath, ttlSec);
        if (error || !data) return null;
        return data.signedUrl;
      },
      upload: async (objectPath, body, contentType) => {
        const { error } = await bucket.upload(objectPath, body, { contentType });
        if (error) throw new Error(error.message);
      },
      list: async (prefix) => {
        const { data, error } = await bucket.list(prefix, { limit: 1000 });
        if (error || !data) throw new Error(error?.message ?? "storage list failed");
        return data.map((obj) => ({ name: obj.name, createdAt: obj.created_at ?? null }));
      },
      remove: async (objectPaths) => {
        const { error } = await bucket.remove(objectPaths);
        if (error) throw new Error(error.message);
      },
    };
  }

  private requireCamera(cameraId: string): void {
    if (!this.deps.cameras.get(cameraId)) {
      throw new LinkError("camera_not_found", `unknown camera ${cameraId}`);
    }
  }

  private async onTimelineDays(message: TimelineDaysMessage): Promise<void> {
    this.requireCamera(message.cameraId);
    await this.send({
      type: "timeline_days_reply",
      requestId: message.requestId,
      cameraId: message.cameraId,
      days: this.deps.db.segmentDays(message.cameraId),
    });
  }

  private async onTimelineCoverage(message: TimelineCoverageMessage): Promise<void> {
    this.requireCamera(message.cameraId);
    const bounds = dayBoundsMs(message.day);
    const rows = this.deps.db.segmentsBetween(message.cameraId, bounds.startMs, bounds.endMs);
    await this.send({
      type: "timeline_coverage_reply",
      requestId: message.requestId,
      cameraId: message.cameraId,
      day: message.day,
      spans: clipSpans(mergeCoverage(rows, Date.now()), bounds.startMs, bounds.endMs),
    });
  }

  private async onTimelineExport(message: TimelineExportMessage): Promise<void> {
    this.requireCamera(message.cameraId);
    const client = this.client;
    const nodeId = this.getNodeId();
    if (!client || !nodeId) throw new LinkError("internal", "cloud session not ready");

    const range = clampExportRange(message.fromMs, message.toMs);
    if (!range) throw new LinkError("internal", "invalid export range");
    if (this.deps.recorder.segmentsBetween(message.cameraId, range.fromMs, range.toMs).length === 0) {
      throw new LinkError("internal", "no recordings in that range");
    }

    const url = await exportTimelineClip({
      nodeId,
      cameraId: message.cameraId,
      fromMs: range.fromMs,
      toMs: range.toMs,
      tmpDir: path.join(this.deps.store.get().paths.recordings, ".exports"),
      storage: this.timelineStorage(client),
      exportRange: async (fromMs, toMs, outPath) => {
        await this.deps.recorder.exportRange(message.cameraId, fromMs, toMs, outPath);
      },
    });
    await this.send({ type: "timeline_export_reply", requestId: message.requestId, url });
  }

  /**
   * Hover preview: extract (or reuse) the minute-bucketed frame from the local
   * preview cache, upload it once to the "snapshots" bucket at
   * {nodeId}/previews/{cameraId}-{bucketMs}.jpg (skipped when the object
   * already exists — signed directly), reply with a 600s signed URL.
   */
  private async onTimelinePreview(message: TimelinePreviewMessage): Promise<void> {
    this.requireCamera(message.cameraId);
    const client = this.client;
    const nodeId = this.getNodeId();
    if (!client || !nodeId) throw new LinkError("internal", "cloud session not ready");

    const bucketMs = previewBucketMs(message.atMs);
    const objectPath = `${nodeId}/previews/${message.cameraId}-${bucketMs}.jpg`;
    const bucket = client.storage.from("snapshots");
    const sign = async (): Promise<string | null> => {
      const { data, error } = await bucket.createSignedUrl(objectPath, PREVIEW_SIGNED_URL_TTL_S);
      if (error || !data) return null;
      return data.signedUrl;
    };

    // Minute-bucketed frames are immutable — an existing object is reusable.
    const existing = await sign();
    if (existing) {
      await this.send({ type: "timeline_preview_reply", requestId: message.requestId, url: existing });
      return;
    }

    const jpgPath = await getPreviewFrame(
      {
        recordingsDir: this.deps.store.get().paths.recordings,
        segmentsBetween: (cameraId, t0Ms, t1Ms) => this.deps.db.segmentsBetween(cameraId, t0Ms, t1Ms),
        log: this.log,
      },
      message.cameraId,
      message.atMs,
    );
    if (!jpgPath) throw new LinkError("internal", "no recording at that time");

    const bytes = readFileSync(jpgPath);
    const { error: uploadError } = await bucket.upload(objectPath, bytes, {
      contentType: "image/jpeg",
    });
    if (uploadError) {
      // Duplicate-upload race — if the object is signable now, someone else won.
      const raced = await sign();
      if (raced) {
        await this.send({ type: "timeline_preview_reply", requestId: message.requestId, url: raced });
        return;
      }
      throw new LinkError("internal", `preview upload: ${uploadError.message}`);
    }
    const url = await sign();
    if (!url) throw new LinkError("internal", "uploaded preview could not be signed");
    await this.send({ type: "timeline_preview_reply", requestId: message.requestId, url });
  }

  /** Replace a camera's activity zones (already validated by the shared Zone
   *  schema during RealtimeMessage parsing). Persisting via the camera manager
   *  triggers the config-change fanout: motion masks rebuild and the camera
   *  row (zones included) re-syncs to the cloud. */
  private async onUpdateZones(message: UpdateZonesMessage): Promise<void> {
    this.requireCamera(message.cameraId);
    const updated = this.deps.cameras.updateCamera(message.cameraId, { zones: message.zones });
    if (!updated) throw new LinkError("camera_not_found", `unknown camera ${message.cameraId}`);
    this.log.info(
      `zones updated for camera ${message.cameraId} (${message.zones.length} zone(s))`,
    );
    await this.send({ type: "update_zones_reply", requestId: message.requestId, ok: true });
  }

  private async onStatusRequest(requestId: string): Promise<void> {
    const streams = await this.deps.go2rtc.streams();
    const now = Date.now();
    const cameras = this.deps.cameras.list().map((camera) => {
      const recording = camera.enabled && camera.record;
      const lastSegmentAtMs = this.deps.recorder.lastSegmentAt(camera.id);
      const capturing = isCaptureLive(lastSegmentAtMs, now);
      return {
        cameraId: camera.id,
        // Recording cameras report real capture liveness (segments actually
        // landing); others keep the go2rtc-config heuristic.
        online: recording
          ? capturing
          : streams !== null && go2rtcStreamName(camera.id) in streams,
        recording,
        capturing,
        ...(lastSegmentAtMs !== null
          ? { lastSegmentAt: new Date(lastSegmentAtMs).toISOString() }
          : {}),
      };
    });

    let disk: DiskInfo;
    try {
      const stats = statfsSync(this.deps.store.get().paths.recordings);
      disk = {
        usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
        totalBytes: stats.blocks * stats.bsize,
      };
    } catch {
      // /recordings may not exist in dev — omit disk info.
    }

    await this.send({
      type: "status_reply",
      requestId,
      version: this.deps.version,
      uptimeSec: Math.round(process.uptime()),
      cameras,
      ...(disk ? { disk } : {}),
    });
  }
}
