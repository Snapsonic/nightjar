import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configDir, type ConfigStore } from "../config/store.js";
import type { NodeDb } from "../db.js";
import type { Logger } from "../log.js";

/**
 * OAuth scope: drive.file ONLY — the node can see and manage only files and
 * folders it created itself. It deliberately CANNOT read, list or modify
 * anything else in the user's Drive.
 */
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Refresh the access token when less than this is left on it. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** How long the cached /about (email + storage quota) result stays fresh. */
const ABOUT_TTL_MS = 5 * 60_000;
/** Bounded offline queue — oldest jobs beyond this are dropped. */
const MAX_QUEUED_BACKUPS = 500;
const BACKUP_IDLE_MS = 10_000;
const BACKUP_BACKOFF_BASE_MS = 5_000;
const BACKUP_BACKOFF_CAP_MS = 300_000;
/** Device-flow poll default when Google omits `interval`. */
const DEVICE_POLL_DEFAULT_S = 5;
/** Max resumable-upload PUT rounds (initial + 308 resumes) per file. */
const MAX_UPLOAD_ROUNDS = 5;

/** Google endpoints — injectable so tests can point at a local mock server. */
export interface GdriveEndpoints {
  deviceCode: string;
  token: string;
  revoke: string;
  /** Drive REST base, e.g. https://www.googleapis.com/drive/v3 */
  api: string;
  /** Drive upload base, e.g. https://www.googleapis.com/upload/drive/v3 */
  upload: string;
}

export const GOOGLE_ENDPOINTS: GdriveEndpoints = {
  deviceCode: "https://oauth2.googleapis.com/device/code",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  api: "https://www.googleapis.com/drive/v3",
  upload: "https://www.googleapis.com/upload/drive/v3",
};

/** ${CONFIG_DIR}/gdrive-token.json (mode 0600, like identity.json). */
const TokenFile = z.object({
  refreshToken: z.string(),
  accessToken: z.string(),
  /** ISO time the current access token expires. */
  expiresAt: z.string(),
  email: z.string().optional(),
});
type TokenFile = z.infer<typeof TokenFile>;

const DeviceCodeResponse = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_url: z.string(),
  expires_in: z.number(),
  interval: z.number().optional(),
});

const TokenGrant = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
});

const RefreshGrant = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

const FileList = z.object({
  files: z.array(z.object({ id: z.string() })).default([]),
});

const FileResource = z.object({ id: z.string() });

const AboutResponse = z.object({
  user: z.object({ emailAddress: z.string().optional() }).optional(),
  // Drive returns int64 quota fields as strings; `limit` is absent when unlimited.
  storageQuota: z.object({ limit: z.string().optional(), usage: z.string().optional() }).optional(),
});

export type GdriveStatus =
  | { status: "notConfigured" }
  | { status: "disconnected" }
  | { status: "connecting"; userCode: string; verificationUrl: string; expiresAt: string }
  | {
      status: "connected";
      email: string | null;
      folderName: string;
      enabled: boolean;
      queued: number;
      quota: { usageBytes: number; limitBytes: number | null } | null;
    }
  | { status: "error"; message: string };

export interface GdriveBackupDeps {
  db: NodeDb;
  store: ConfigStore;
  log: Logger;
  /** Test override; defaults to the real Google endpoints. */
  endpoints?: GdriveEndpoints;
  /** Test override for the token-file directory; defaults to configDir(). */
  dir?: string;
}

interface AboutCache {
  email: string | null;
  quota: { usageBytes: number; limitBytes: number | null } | null;
  fetchedAtMs: number;
}

/** Drive names may not sensibly contain path separators; keep them flat. */
function safeName(name: string): string {
  const cleaned = name.replace(/[/\\]/g, "-").trim();
  return cleaned.length > 0 ? cleaned : "unnamed";
}

/** Escape a value for a Drive files.list `q` string literal. */
function queryEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * "Bring your own cloud" backup to the user's Google Drive.
 *
 * Auth is the OAuth 2.0 Device Flow ("TV and Limited-Input Device" client):
 * the node shows a short code, the user enters it at google.com/device, and
 * the node polls for the grant — no browser or redirect URI on the node.
 * Tokens live in ${CONFIG_DIR}/gdrive-token.json (mode 0600) and never leave
 * the node; they are never logged. Disconnect revokes the grant at Google and
 * deletes the file.
 *
 * When connected and backup.gdrive.enabled, every closed event's clip and
 * thumbnail also upload to Drive under
 *   <folderName>/<camera name>/<YYYY-MM-DD>/<HHmmss>-<kind>.mp4 (+ .jpg)
 * via a serial queue (gdrive_queue — survives restarts, backoff 5s→5min,
 * bounded to the newest 500). Backup is forward-only: events closed while
 * disconnected/disabled are not retroactively uploaded. The clip dir under
 * .clips/<eventId>/ is shared with the Supabase upload queue and is deleted
 * only once neither queue references the event (NodeDb.clipReferenced).
 */
export class GdriveBackup {
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly wakers = new Set<() => void>();
  private unsubscribeConfig: (() => void) | null = null;

  private readonly endpoints: GdriveEndpoints;
  private readonly tokenPath: string;
  private token: TokenFile | null = null;
  private connecting: { userCode: string; verificationUrl: string; expiresAt: string } | null =
    null;
  private lastError: string | null = null;
  private about: AboutCache | null = null;
  /** parentId/name -> folderId; write-through to the gdrive_folders table. */
  private readonly folderCache = new Map<string, string>();
  private readonly log: Logger;

  constructor(private readonly deps: GdriveBackupDeps) {
    this.log = deps.log;
    this.endpoints = deps.endpoints ?? GOOGLE_ENDPOINTS;
    this.tokenPath = path.join(deps.dir ?? configDir(), "gdrive-token.json");
    this.token = this.loadToken();
  }

  /* ---------- lifecycle ---------- */

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.token) this.log.info("Google Drive backup: stored token found — connected");
    this.unsubscribeConfig = this.deps.store.onChange(() => this.kick());
    this.loop = this.runUploader().catch((err) => {
      this.log.error(
        `gdrive uploader crashed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connecting = null;
    this.unsubscribeConfig?.();
    this.unsubscribeConfig = null;
    for (const wake of [...this.wakers]) wake();
    await this.loop;
    this.loop = null;
  }

  /* ---------- credentials & token file ---------- */

  /**
   * OAuth client credentials for the device flow. Env first, then config —
   * absent on builds without them; the feature then shows as "not configured"
   * in the UI (self-hosters supply their own client, see the node README).
   */
  private credentials(): { clientId: string; clientSecret: string } | null {
    const gdrive = this.deps.store.get().backup.gdrive;
    const clientId = process.env.NIGHTJAR_GOOGLE_CLIENT_ID || gdrive.clientId;
    const clientSecret = process.env.NIGHTJAR_GOOGLE_CLIENT_SECRET || gdrive.clientSecret;
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  }

  private loadToken(): TokenFile | null {
    try {
      return TokenFile.parse(JSON.parse(readFileSync(this.tokenPath, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.warn("gdrive token file unreadable/invalid — treating as disconnected");
      }
      return null;
    }
  }

  /** Atomic write, mode 0600 — the token file is a credential. */
  private saveToken(token: TokenFile): void {
    this.token = token;
    mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    const tmp = `${this.tokenPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(token, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.tokenPath);
  }

  private dropToken(): void {
    this.token = null;
    this.about = null;
    rmSync(this.tokenPath, { force: true });
  }

  /* ---------- public status / control ---------- */

  async getStatus(): Promise<GdriveStatus> {
    if (!this.credentials()) return { status: "notConfigured" };
    if (this.connecting && Date.parse(this.connecting.expiresAt) > Date.now()) {
      return { status: "connecting", ...this.connecting };
    }
    if (this.token) {
      // Best-effort quota/email refresh (TTL 5 min); stale cache still serves.
      await this.refreshAbout().catch(() => {});
      const gdrive = this.deps.store.get().backup.gdrive;
      return {
        status: "connected",
        email: this.about?.email ?? this.token?.email ?? null,
        folderName: gdrive.folderName,
        enabled: gdrive.enabled,
        queued: this.deps.db.countGdriveQueue(),
        quota: this.about?.quota ?? null,
      };
    }
    if (this.lastError) return { status: "error", message: this.lastError };
    return { status: "disconnected" };
  }

  /** Kick off the device flow. Idempotent while a flow is already pending. */
  async startConnect(): Promise<GdriveStatus> {
    const creds = this.credentials();
    if (!creds) return { status: "notConfigured" };
    if (this.token) return this.getStatus();
    if (this.connecting && Date.parse(this.connecting.expiresAt) > Date.now()) {
      return { status: "connecting", ...this.connecting };
    }
    this.lastError = null;
    let res: Response;
    try {
      res = await this.formPost(this.endpoints.deviceCode, {
        client_id: creds.clientId,
        scope: DRIVE_SCOPE,
      });
    } catch (err) {
      this.lastError = `Google unreachable: ${err instanceof Error ? err.message : String(err)}`;
      return { status: "error", message: this.lastError };
    }
    if (!res.ok) {
      this.lastError = `device code request failed: HTTP ${res.status}`;
      return { status: "error", message: this.lastError };
    }
    const grant = DeviceCodeResponse.parse(await res.json());
    this.connecting = {
      userCode: grant.user_code,
      verificationUrl: grant.verification_url,
      expiresAt: new Date(Date.now() + grant.expires_in * 1000).toISOString(),
    };
    this.log.info("Google Drive device flow started — waiting for the user code to be entered");
    void this.pollDeviceFlow(creds, grant.device_code, grant.interval, grant.expires_in).catch(
      (err) => {
        this.connecting = null;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.log.warn(`gdrive device flow failed: ${this.lastError}`);
      },
    );
    return { status: "connecting", ...this.connecting };
  }

  /** Revoke the grant at Google (best effort) and delete the token file. */
  async disconnect(): Promise<void> {
    this.connecting = null;
    this.lastError = null;
    const token = this.token;
    this.folderCache.clear();
    this.deps.db.clearGdriveFolders();
    this.dropToken();
    if (!token) return;
    try {
      const res = await this.formPost(
        `${this.endpoints.revoke}?token=${encodeURIComponent(token.refreshToken)}`,
        {},
      );
      if (!res.ok) this.log.warn(`gdrive token revoke returned HTTP ${res.status}`);
    } catch (err) {
      this.log.warn(
        `gdrive token revoke failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.log.info("Google Drive disconnected — grant revoked, token file deleted");
  }

  /**
   * Enqueue a Drive backup for a freshly closed event — only when enabled and
   * connected at enqueue time (forward-only; nothing retroactive).
   */
  enqueueIfActive(eventId: string, dir: string): void {
    if (!this.deps.store.get().backup.gdrive.enabled || !this.token) return;
    this.deps.db.enqueueGdrive(eventId, dir);
    for (const dropped of this.deps.db.trimGdriveQueue(MAX_QUEUED_BACKUPS)) {
      this.releaseClipDir(dropped.event_id, dropped.file);
      this.log.warn(`gdrive queue full — dropped event ${dropped.event_id}`);
    }
    this.kick();
  }

  /* ---------- device flow polling ---------- */

  private async pollDeviceFlow(
    creds: { clientId: string; clientSecret: string },
    deviceCode: string,
    intervalS: number | undefined,
    expiresInS: number,
  ): Promise<void> {
    let intervalMs = (intervalS ?? DEVICE_POLL_DEFAULT_S) * 1000;
    const deadline = Date.now() + expiresInS * 1000;
    while (this.running && this.connecting && Date.now() < deadline) {
      await this.sleep(intervalMs);
      if (!this.running || !this.connecting) return;
      const res = await this.formPost(this.endpoints.token, {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        const grant = TokenGrant.parse(body);
        this.saveToken({
          refreshToken: grant.refresh_token,
          accessToken: grant.access_token,
          expiresAt: new Date(Date.now() + grant.expires_in * 1000).toISOString(),
        });
        this.connecting = null;
        this.log.info("Google Drive connected");
        await this.refreshAbout().catch(() => {});
        if (this.about?.email && this.token) {
          this.saveToken({ ...this.token, email: this.about.email });
        }
        this.kick();
        return;
      }
      const error = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      this.connecting = null;
      if (error === "access_denied") this.lastError = "access was denied on the Google page";
      else if (error === "expired_token") this.lastError = "the code expired before it was entered";
      else this.lastError = `device flow failed: ${error}`;
      this.log.warn(`gdrive device flow ended: ${this.lastError}`);
      return;
    }
    if (this.connecting) {
      this.connecting = null;
      this.lastError = "the code expired before it was entered";
    }
  }

  /* ---------- token refresh & authed fetch ---------- */

  /** Access token, refreshed via refresh_token grant when <5 min remain. */
  private async getAccessToken(force = false): Promise<string> {
    const token = this.token;
    if (!token) throw new Error("google drive not connected");
    if (!force && Date.parse(token.expiresAt) - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return token.accessToken;
    }
    const creds = this.credentials();
    if (!creds) throw new Error("google client credentials missing");
    const res = await this.formPost(this.endpoints.token, {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: token.refreshToken,
      grant_type: "refresh_token",
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const error = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
      if (error === "invalid_grant") {
        // Grant revoked from the Google account side — forget our copy.
        this.log.warn("gdrive refresh token no longer valid — disconnecting locally");
        this.dropToken();
      }
      throw new Error(`token refresh failed: ${error}`);
    }
    const grant = RefreshGrant.parse(body);
    this.saveToken({
      ...token,
      accessToken: grant.access_token,
      expiresAt: new Date(Date.now() + grant.expires_in * 1000).toISOString(),
    });
    return grant.access_token;
  }

  /** Authenticated Drive fetch; on 401 retries once with a fresh token. */
  private async driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const doFetch = async (accessToken: string): Promise<Response> =>
      fetch(url, {
        ...init,
        headers: {
          ...((init.headers as Record<string, string> | undefined) ?? {}),
          authorization: `Bearer ${accessToken}`,
        },
      });
    let res = await doFetch(await this.getAccessToken());
    if (res.status === 401) {
      res = await doFetch(await this.getAccessToken(true));
    }
    return res;
  }

  private formPost(url: string, params: Record<string, string>): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  /* ---------- account info ---------- */

  private async refreshAbout(): Promise<void> {
    if (!this.token) return;
    if (this.about && Date.now() - this.about.fetchedAtMs < ABOUT_TTL_MS) return;
    const res = await this.driveFetch(`${this.endpoints.api}/about?fields=user,storageQuota`);
    if (!res.ok) throw new Error(`about: HTTP ${res.status}`);
    const about = AboutResponse.parse(await res.json());
    this.about = {
      email: about.user?.emailAddress ?? null,
      quota: about.storageQuota
        ? {
            usageBytes: Number(about.storageQuota.usage ?? "0"),
            limitBytes:
              about.storageQuota.limit !== undefined ? Number(about.storageQuota.limit) : null,
          }
        : null,
      fetchedAtMs: Date.now(),
    };
  }

  /* ---------- folders ---------- */

  /** Find-before-create; ids cached in memory and the gdrive_folders table. */
  private async ensureFolder(parentId: string, name: string): Promise<string> {
    const cacheKey = `${parentId}/${name}`;
    const cached = this.folderCache.get(cacheKey) ?? this.deps.db.getGdriveFolder(cacheKey);
    if (cached) {
      this.folderCache.set(cacheKey, cached);
      return cached;
    }
    const q =
      `name='${queryEscape(name)}' and '${queryEscape(parentId)}' in parents` +
      ` and mimeType='${FOLDER_MIME}' and trashed=false`;
    const listRes = await this.driveFetch(
      `${this.endpoints.api}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
    );
    if (!listRes.ok) throw new Error(`folder lookup "${name}": HTTP ${listRes.status}`);
    let id = FileList.parse(await listRes.json()).files[0]?.id;
    if (!id) {
      const createRes = await this.driveFetch(`${this.endpoints.api}/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      });
      if (!createRes.ok) throw new Error(`folder create "${name}": HTTP ${createRes.status}`);
      id = FileResource.parse(await createRes.json()).id;
    }
    this.folderCache.set(cacheKey, id);
    this.deps.db.setGdriveFolder(cacheKey, id);
    return id;
  }

  /* ---------- file upload (resumable) ---------- */

  /** True when a non-trashed file with this name already exists in the folder. */
  private async findFile(folderId: string, name: string): Promise<boolean> {
    const q = `name='${queryEscape(name)}' and '${queryEscape(folderId)}' in parents and trashed=false`;
    const res = await this.driveFetch(
      `${this.endpoints.api}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
    );
    if (!res.ok) throw new Error(`file lookup "${name}": HTTP ${res.status}`);
    return FileList.parse(await res.json()).files.length > 0;
  }

  /**
   * Resumable upload: POST uploadType=resumable for a session URL, then PUT
   * the bytes; a 308 response carries a Range header telling us how much the
   * server kept, and we resume from there with a Content-Range PUT. Skips the
   * upload entirely if the file already exists (idempotent across retries).
   */
  private async uploadFile(
    folderId: string,
    name: string,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    if (await this.findFile(folderId, name)) return;
    const bytes = readFileSync(filePath);
    const sessionRes = await this.driveFetch(`${this.endpoints.upload}/files?uploadType=resumable`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": contentType,
        "x-upload-content-length": String(bytes.length),
      },
      body: JSON.stringify({ name, parents: [folderId] }),
    });
    if (!sessionRes.ok) throw new Error(`resumable session "${name}": HTTP ${sessionRes.status}`);
    const sessionUrl = sessionRes.headers.get("location");
    if (!sessionUrl) throw new Error(`resumable session "${name}": missing Location header`);

    let offset = 0;
    for (let round = 0; round < MAX_UPLOAD_ROUNDS; round++) {
      const headers: Record<string, string> = { "content-type": contentType };
      if (offset > 0) {
        headers["content-range"] = `bytes ${offset}-${bytes.length - 1}/${bytes.length}`;
      }
      const res = await fetch(sessionUrl, {
        method: "PUT",
        headers,
        body: bytes.subarray(offset),
      });
      if (res.ok) return;
      if (res.status === 308) {
        // "Resume Incomplete" — Range: bytes=0-N tells us N bytes are stored.
        const match = res.headers.get("range")?.match(/(\d+)$/);
        offset = match ? Number(match[1]) + 1 : 0;
        continue;
      }
      throw new Error(`upload "${name}": HTTP ${res.status}`);
    }
    throw new Error(`upload "${name}": did not complete after ${MAX_UPLOAD_ROUNDS} rounds`);
  }

  /* ---------- backup worker ---------- */

  private kick(): void {
    for (const wake of [...this.wakers]) wake();
  }

  /** Interruptible sleep — resolves early on stop()/kick(). */
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

  /** Delete the shared clip dir only once no queue still needs the event. */
  private releaseClipDir(eventId: string, dir: string): void {
    if (!this.deps.db.clipReferenced(eventId)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async runUploader(): Promise<void> {
    while (this.running) {
      // The whole iteration (nextGdrive included) is guarded: an unexpected
      // throw must never end this loop while the backup is running.
      try {
        await this.uploaderIteration();
      } catch (err) {
        this.log.error(
          `gdrive iteration failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.sleep(BACKUP_IDLE_MS);
      }
    }
  }

  private async uploaderIteration(): Promise<void> {
    const active = this.deps.store.get().backup.gdrive.enabled && this.token !== null;
    const job = active ? this.deps.db.nextGdrive() : undefined;
    if (!job) {
      await this.sleep(BACKUP_IDLE_MS);
      return;
    }
    try {
      await this.backupEvent(job.event_id, job.file);
      this.deps.db.deleteGdrive(job.id);
      this.releaseClipDir(job.event_id, job.file);
      this.log.info(`event ${job.event_id} backed up to Google Drive`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("HTTP 404")) {
        // A cached folder id may point at a folder the user deleted in
        // Drive — drop the cache so the retry re-resolves the chain.
        this.folderCache.clear();
        this.deps.db.clearGdriveFolders();
      }
      this.deps.db.bumpGdriveAttempts(job.id);
      const backoff = Math.min(
        BACKUP_BACKOFF_BASE_MS * 2 ** Math.min(job.attempts, 10),
        BACKUP_BACKOFF_CAP_MS,
      );
      this.log.warn(
        `gdrive backup of event ${job.event_id} failed (attempt ${job.attempts + 1}): ` +
          `${message} — retrying in ${Math.round(backoff / 1000)}s`,
      );
      await this.sleep(backoff);
    }
  }

  /** One event: folder chain <folderName>/<camera>/<YYYY-MM-DD>, clip + thumb. */
  private async backupEvent(eventId: string, dir: string): Promise<void> {
    const row = this.deps.db.getEvent(eventId);
    if (!row) {
      this.log.warn(`gdrive job for event ${eventId}: event missing locally — skipping`);
      return;
    }
    const clipPath = path.join(dir, "clip.mp4");
    if (!existsSync(clipPath)) {
      this.log.warn(`gdrive job for event ${eventId}: clip file missing — skipping`);
      return;
    }
    const config = this.deps.store.get();
    const camera = config.cameras.find((c) => c.id === row.camera_id);
    const cameraName = safeName(camera?.name ?? row.camera_id.slice(0, 8));
    const started = new Date(row.started_at);
    const day = `${started.getFullYear()}-${pad2(started.getMonth() + 1)}-${pad2(started.getDate())}`;
    const time = `${pad2(started.getHours())}${pad2(started.getMinutes())}${pad2(started.getSeconds())}`;

    const rootId = await this.ensureFolder("root", safeName(config.backup.gdrive.folderName));
    const cameraFolderId = await this.ensureFolder(rootId, cameraName);
    const dayFolderId = await this.ensureFolder(cameraFolderId, day);

    const base = `${time}-${row.kind}`;
    await this.uploadFile(dayFolderId, `${base}.mp4`, clipPath, "video/mp4");
    const thumbPath = path.join(dir, "thumb.jpg");
    if (existsSync(thumbPath)) {
      await this.uploadFile(dayFolderId, `${base}.jpg`, thumbPath, "image/jpeg");
    }
  }
}
