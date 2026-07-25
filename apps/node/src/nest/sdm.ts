import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CameraCapabilities } from "@nightjar/shared";
import { configDir, type ConfigStore } from "../config/store.js";
import { Emitter } from "../emitter.js";
import type { Logger } from "../log.js";

/**
 * OAuth scope for the Smart Device Management API. Unlike Drive's drive.file,
 * sdm.service is NOT a device-flow scope — auth is the standard
 * authorization-code flow. The node has no public redirect URI, so we use the
 * manual paste-back pattern: the consent URL redirects to https://www.google.com,
 * the user lands there with ?code=... in the address bar and pastes the full
 * URL (or just the code) back into the local UI.
 */
const SDM_SCOPE = "https://www.googleapis.com/auth/sdm.service";
const REDIRECT_URI = "https://www.google.com";
/** Refresh the access token when less than this is left on it. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** Device list cache TTL — keeps the 5s UI poll from hammering the SDM API. */
const DEVICES_TTL_MS = 60_000;
const CAMERA_TRAIT = "sdm.devices.traits.CameraLiveStream";
const INFO_TRAIT = "sdm.devices.traits.Info";

/** Google endpoints — injectable so tests can point at a local mock server. */
export interface NestEndpoints {
  auth: string;
  token: string;
  revoke: string;
  /** SDM REST base, e.g. https://smartdevicemanagement.googleapis.com/v1 */
  api: string;
  /** Partner Connections base — consent pages live at {base}/{projectId}/auth. */
  partnerAuthBase: string;
}

export const NEST_GOOGLE_ENDPOINTS: NestEndpoints = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  partnerAuthBase: "https://nestservices.google.com/partnerconnections",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  api: "https://smartdevicemanagement.googleapis.com/v1",
};

/** ${CONFIG_DIR}/nest-token.json (mode 0600, like gdrive-token.json). */
const TokenFile = z.object({
  refreshToken: z.string(),
  accessToken: z.string(),
  /** ISO time the current access token expires. */
  expiresAt: z.string(),
});
type TokenFile = z.infer<typeof TokenFile>;

const TokenGrant = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
});

const RefreshGrant = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

const SdmResolution = z.object({
  width: z.number().optional(),
  height: z.number().optional(),
});

const SdmCameraLiveStream = z.object({
  supportedProtocols: z.array(z.string()).default([]),
  maxVideoResolution: SdmResolution.optional(),
  videoCodecs: z.array(z.string()).default([]),
  audioCodecs: z.array(z.string()).default([]),
});

const SdmDevice = z.object({
  /** "enterprises/{projectId}/devices/{deviceId}" */
  name: z.string(),
  type: z.string().optional(),
  traits: z.record(z.unknown()).default({}),
  parentRelations: z
    .array(z.object({ parent: z.string().optional(), displayName: z.string().optional() }))
    .default([]),
});

const SdmDeviceList = z.object({
  devices: z.array(SdmDevice).default([]),
  nextPageToken: z.string().optional(),
});

/** A Nest camera as shown in the local UI's device picker. */
export interface NestDevice {
  deviceId: string;
  name: string;
  room: string | null;
  /** SDM device type, e.g. "sdm.devices.types.DOORBELL". */
  type: string | null;
  /** Live-stream protocols the device supports, e.g. ["WEB_RTC"] or ["RTSP"]. */
  protocols: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  maxVideoResolution: { width: number; height: number } | null;
}

export interface NestDeviceListResult {
  devices: NestDevice[];
  /** True when SDM returned zero devices — the classic first-run gotcha:
   *  the Partner Connections Manager link flow has not been completed yet. */
  needsPartnerLink: boolean;
  partnerConnectionsUrl: string;
}

/** Everything the go2rtc `nest:` source line needs. */
export interface NestStreamParams {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  projectId: string;
}

export type NestStatus =
  | { status: "notConfigured"; missing: string[] }
  | { status: "disconnected" }
  | { status: "connected"; projectId: string; devices?: NestDevice[] }
  | { status: "error"; message: string };

export interface NestBridgeDeps {
  store: ConfigStore;
  log: Logger;
  /** Test override; defaults to the real Google endpoints. */
  endpoints?: NestEndpoints;
  /** Test override for the token-file directory; defaults to configDir(). */
  dir?: string;
}

/** "enterprises/{pid}/devices/{did}" -> "{did}". */
export function getDeviceId(sdmName: string): string {
  const parts = sdmName.split("/");
  return parts[parts.length - 1] ?? sdmName;
}

/**
 * Nest camera bridge over Google's Smart Device Management API.
 *
 * The bridge only handles OAuth + device discovery; the actual video path is
 * go2rtc's native `nest:` source, which the Go2rtcSupervisor renders from
 * getStreamParams(). Tokens live in ${CONFIG_DIR}/nest-token.json (mode 0600)
 * and never leave the node; they are never logged. Disconnect revokes the
 * grant at Google and deletes the file.
 */
export class NestBridge {
  private readonly endpoints: NestEndpoints;
  private readonly tokenPath: string;
  private token: TokenFile | null = null;
  private lastError: string | null = null;
  private devicesCache: { devices: NestDevice[]; fetchedAtMs: number } | null = null;
  private readonly emitter = new Emitter<void>();
  private readonly log: Logger;

  constructor(private readonly deps: NestBridgeDeps) {
    this.log = deps.log;
    this.endpoints = deps.endpoints ?? NEST_GOOGLE_ENDPOINTS;
    this.tokenPath = path.join(deps.dir ?? configDir(), "nest-token.json");
    this.token = this.loadToken();
    if (this.token) this.log.info("Nest bridge: stored token found — connected");
  }

  /** Fires after connect/disconnect so the go2rtc config can re-render. */
  onChange(listener: () => void): () => void {
    return this.emitter.on(listener);
  }

  /* ---------- credentials & token file ---------- */

  /** SDM credentials from config.nest — all three are required to do anything. */
  private credentials(): {
    projectId: string;
    clientId: string;
    clientSecret: string;
  } | null {
    const nest = this.deps.store.get().nest;
    if (!nest.projectId || !nest.clientId || !nest.clientSecret) return null;
    return { projectId: nest.projectId, clientId: nest.clientId, clientSecret: nest.clientSecret };
  }

  private missingCredentials(): string[] {
    const nest = this.deps.store.get().nest;
    const missing: string[] = [];
    if (!nest.projectId) missing.push("projectId");
    if (!nest.clientId) missing.push("clientId");
    if (!nest.clientSecret) missing.push("clientSecret");
    return missing;
  }

  private loadToken(): TokenFile | null {
    try {
      return TokenFile.parse(JSON.parse(readFileSync(this.tokenPath, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.warn("nest token file unreadable/invalid — treating as disconnected");
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
    this.devicesCache = null;
    rmSync(this.tokenPath, { force: true });
  }

  /* ---------- public status / control ---------- */

  getStatus(): NestStatus {
    const missing = this.missingCredentials();
    if (missing.length > 0) return { status: "notConfigured", missing };
    if (this.token) {
      return {
        status: "connected",
        projectId: this.deps.store.get().nest.projectId as string,
        ...(this.devicesCache ? { devices: this.devicesCache.devices } : {}),
      };
    }
    if (this.lastError) return { status: "error", message: this.lastError };
    return { status: "disconnected" };
  }

  /** Params for go2rtc's `nest:` source, or null while not fully connected. */
  getStreamParams(): NestStreamParams | null {
    const creds = this.credentials();
    if (!creds || !this.token) return null;
    return {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: this.token.refreshToken,
      projectId: creds.projectId,
    };
  }

  partnerConnectionsUrl(): string {
    const projectId = this.deps.store.get().nest.projectId ?? "";
    return `https://nestservices.google.com/partnerconnections/${projectId}`;
  }

  /**
   * Consent URL for the manual paste-back flow. access_type=offline +
   * prompt=consent force Google to (re)issue a refresh token even when the
   * user granted the scope before.
   */
  buildAuthUrl(): string {
    const creds = this.credentials();
    if (!creds) throw new Error("nest credentials not configured");
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SDM_SCOPE,
      access_type: "offline",
      prompt: "consent",
    });
    // Device Access grants must go through the Partner Connections page for
    // this project — a plain accounts.google.com consent is rejected with
    // access_denied because the grant isn't bound to the SDM project.
    return `${this.endpoints.partnerAuthBase}/${encodeURIComponent(creds.projectId)}/auth?${params.toString()}`;
  }

  /**
   * Accepts either the bare authorization code or the full
   * https://www.google.com/?code=...&scope=... URL from the address bar.
   * Codes contain "/" which arrives percent-encoded in a URL — URL parsing
   * (and a decode fallback for raw "4%2F..." pastes) handles that.
   */
  static extractCode(codeOrUrl: string): string {
    const raw = codeOrUrl.trim();
    if (/^https?:\/\//i.test(raw)) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error("that does not look like a valid URL");
      }
      const code = url.searchParams.get("code");
      if (!code) throw new Error("no ?code= parameter found in the pasted URL");
      return code;
    }
    // A pasted query fragment like "code=4%2F0Ab...&scope=..." also works.
    if (raw.includes("code=")) {
      const code = new URLSearchParams(raw.replace(/^\?/, "")).get("code");
      if (code) return code;
    }
    return raw.includes("%") ? decodeURIComponent(raw) : raw;
  }

  /** Exchange the pasted code for tokens and persist them (mode 0600). */
  async exchangeCode(codeOrUrl: string): Promise<void> {
    const creds = this.credentials();
    if (!creds) throw new Error("nest credentials not configured");
    const code = NestBridge.extractCode(codeOrUrl);
    const res = await this.formPost(this.endpoints.token, {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const error = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
      throw new Error(
        error === "invalid_grant"
          ? "Google rejected the code (expired or already used) — start over from the consent link"
          : `code exchange failed: ${error}`,
      );
    }
    const grant = TokenGrant.safeParse(body);
    if (!grant.success) {
      throw new Error(
        "Google's response had no refresh token — remove the app's access at " +
          "myaccount.google.com/permissions and connect again",
      );
    }
    this.saveToken({
      refreshToken: grant.data.refresh_token,
      accessToken: grant.data.access_token,
      expiresAt: new Date(Date.now() + grant.data.expires_in * 1000).toISOString(),
    });
    this.lastError = null;
    this.log.info("Nest bridge connected — SDM grant stored");
    this.emitter.emit();
  }

  /** Revoke the grant at Google (best effort) and delete the token file. */
  async disconnect(): Promise<void> {
    this.lastError = null;
    const token = this.token;
    this.dropToken();
    if (token) {
      try {
        const res = await this.formPost(
          `${this.endpoints.revoke}?token=${encodeURIComponent(token.refreshToken)}`,
          {},
        );
        if (!res.ok) this.log.warn(`nest token revoke returned HTTP ${res.status}`);
      } catch (err) {
        this.log.warn(
          `nest token revoke failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.log.info("Nest bridge disconnected — grant revoked, token file deleted");
    }
    this.emitter.emit();
  }

  /* ---------- token refresh & authed fetch ---------- */

  /** Access token, refreshed via refresh_token grant when <5 min remain. */
  private async getAccessToken(force = false): Promise<string> {
    const token = this.token;
    if (!token) throw new Error("nest not connected");
    if (!force && Date.parse(token.expiresAt) - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return token.accessToken;
    }
    const creds = this.credentials();
    if (!creds) throw new Error("nest credentials missing");
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
        this.log.warn("nest refresh token no longer valid — disconnecting locally");
        this.dropToken();
        this.emitter.emit();
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

  /** Authenticated SDM fetch; on 401 retries once with a fresh token. */
  private async sdmFetch(url: string): Promise<Response> {
    const doFetch = async (accessToken: string): Promise<Response> =>
      fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
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

  /* ---------- devices ---------- */

  /**
   * SDM devices.list, filtered to devices with the CameraLiveStream trait.
   * Cached for 60s (the local UI polls). An empty list almost always means
   * the Partner Connections Manager link flow was never completed — surfaced
   * via needsPartnerLink so the UI can show the fix.
   */
  async listDevices(forceRefresh = false): Promise<NestDeviceListResult> {
    const creds = this.credentials();
    if (!creds) throw new Error("nest credentials not configured");
    if (
      !forceRefresh &&
      this.devicesCache &&
      Date.now() - this.devicesCache.fetchedAtMs < DEVICES_TTL_MS
    ) {
      return this.toListResult(this.devicesCache.devices);
    }

    const devices: NestDevice[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.endpoints.api}/enterprises/${creds.projectId}/devices`);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await this.sdmFetch(url.toString());
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`devices.list: HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
      }
      const page = SdmDeviceList.parse(await res.json());
      for (const device of page.devices) {
        const parsed = this.toNestDevice(device);
        if (parsed) devices.push(parsed);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    this.devicesCache = { devices, fetchedAtMs: Date.now() };
    return this.toListResult(devices);
  }

  private toListResult(devices: NestDevice[]): NestDeviceListResult {
    return {
      devices,
      needsPartnerLink: devices.length === 0,
      partnerConnectionsUrl: this.partnerConnectionsUrl(),
    };
  }

  /** Keep cameras only; extract display name, room and live-stream traits. */
  private toNestDevice(device: z.infer<typeof SdmDevice>): NestDevice | null {
    const liveStreamRaw = device.traits[CAMERA_TRAIT];
    if (liveStreamRaw === undefined) return null; // no live stream — not a camera
    const liveStream = SdmCameraLiveStream.safeParse(liveStreamRaw);
    const stream = liveStream.success
      ? liveStream.data
      : SdmCameraLiveStream.parse({});
    const info = z
      .object({ customName: z.string().optional() })
      .safeParse(device.traits[INFO_TRAIT]);
    const room = device.parentRelations.find((p) => p.displayName)?.displayName ?? null;
    const customName = info.success ? info.data.customName?.trim() : undefined;
    const resolution = stream.maxVideoResolution;
    return {
      deviceId: getDeviceId(device.name),
      name: customName || room || "Nest camera",
      room,
      type: device.type ?? null,
      protocols: stream.supportedProtocols,
      videoCodecs: stream.videoCodecs,
      audioCodecs: stream.audioCodecs,
      maxVideoResolution:
        resolution?.width && resolution.height
          ? { width: resolution.width, height: resolution.height }
          : null,
    };
  }

  /**
   * Best-effort capabilities for a device from SDM traits (cache first, one
   * live list when connected). ffprobe cannot probe a nest camera at add time
   * — the stream only exists once go2rtc pulls it.
   */
  /** SDM live-stream protocols for a device (["RTSP"] or ["WEB_RTC"]) —
   *  required by the go2rtc source line; empty when unknown. */
  async deviceProtocols(deviceId: string): Promise<string[]> {
    try {
      const { devices } = await this.listDevices();
      return devices.find((d) => d.deviceId === deviceId)?.protocols ?? [];
    } catch {
      return [];
    }
  }

  async deviceCapabilities(deviceId: string): Promise<CameraCapabilities | undefined> {
    try {
      const { devices } = await this.listDevices();
      const device = devices.find((d) => d.deviceId === deviceId);
      if (!device) return undefined;
      return CameraCapabilities.parse({
        hasSubstream: false,
        videoCodec: device.videoCodecs[0]?.toLowerCase(),
        audioCodec: device.audioCodecs[0]?.toLowerCase(),
        hasAudio: device.audioCodecs.length > 0,
        // talkback stays "none": SDM offers no way to send audio to
        // RTSP-generation Nest cameras.
        width: device.maxVideoResolution?.width,
        height: device.maxVideoResolution?.height,
      });
    } catch {
      return undefined;
    }
  }
}
