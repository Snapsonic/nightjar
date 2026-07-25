import { statfsSync } from "node:fs";
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
import type { Go2rtcSupervisor } from "../go2rtc/supervisor.js";
import type { Logger } from "../log.js";

type WhepOfferMessage = Extract<RealtimeMessage, { type: "whep_offer" }>;
type SnapshotRequestMessage = Extract<RealtimeMessage, { type: "snapshot_request" }>;
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
  version: string;
  log: Logger;
}

const TOKEN_POLL_MS = 30_000;
const HEARTBEAT_MS = 60_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

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
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${name} failed: HTTP ${res.status} ${detail}`.trim());
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
        backoff = BACKOFF_START_MS;
        await this.session(token);
      } catch (err) {
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

    const sync = async (): Promise<void> => {
      try {
        await this.syncCameras(client, nodeId);
      } catch (err) {
        this.log.warn(`camera sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void sync();
    const unsubscribeConfig = this.deps.store.onChange(() => void sync());

    // Reconnect (fresh token + client) shortly before the token expires.
    const msLeft = Date.parse(token.expiresAt) - Date.now();
    const refreshIn = Math.max(10_000, msLeft - 5 * 60_000);
    const refreshTimer = setTimeout(() => endSession("token refresh"), refreshIn);
    refreshTimer.unref();

    await endedPromise;

    clearInterval(heartbeatTimer);
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
      res = await fetch(`${this.deps.go2rtc.apiUrl()}/api/whep?src=${encodeURIComponent(src)}`, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: message.sdp,
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

    let res: Response;
    try {
      res = await fetch(
        `${this.deps.go2rtc.apiUrl()}/api/frame.jpeg?src=${encodeURIComponent(go2rtcStreamName(camera.id))}`,
      );
    } catch {
      throw new LinkError("go2rtc_unreachable", "go2rtc is not responding");
    }
    if (!res.ok) throw new LinkError("camera_offline", `snapshot returned HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();

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

  private async onStatusRequest(requestId: string): Promise<void> {
    const streams = await this.deps.go2rtc.streams();
    const cameras = this.deps.cameras.list().map((camera) => ({
      cameraId: camera.id,
      online: streams !== null && go2rtcStreamName(camera.id) in streams,
      recording: camera.enabled && camera.record,
    }));

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
