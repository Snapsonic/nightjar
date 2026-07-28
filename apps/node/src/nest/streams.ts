/**
 * Ownership of Nest (SDM) RTSP stream lifetimes.
 *
 * Why this exists: go2rtc's built-in `nest:` source mints its own SDM stream
 * and renews it on its own timer. That timer is unreliable — it panics on a
 * nil dereference inside StartExtendStreamTimer, and when the renewal simply
 * times out the producer dies, every consumer (recorder + motion detector)
 * drops at once, and each reconnect asks Google for a brand new stream. SDM
 * rate-limits stream commands per project per minute, so a few cameras
 * reconnecting together saturate the quota, Google starts 429ing, and the
 * cameras stay down. Measured cost before this module: recording gaps of up
 * to four minutes per camera and ~800 failed SDM calls in 18 minutes.
 *
 * The fix is to stop regenerating. An SDM RTSP stream expires ~5 minutes after
 * it is generated, but ExtendRtspStream pushes the expiry to five minutes from
 * *now* and can be called indefinitely. Extension returns a fresh streamToken
 * and NO new URL: an already-established RTSP session keeps flowing, because
 * the token only authenticates the initial DESCRIBE. So one generate per
 * camera plus a renewal every few minutes holds a stream open forever, and the
 * only SDM calls left are the cheap extends.
 *
 * go2rtc is then handed a plain `rtsps://` URL and never talks to Google.
 */

import { StreamStartGate } from "../backoff.js";
import { Emitter } from "../emitter.js";
import type { Logger } from "../log.js";
import { NestCommandError, type NestBridge } from "./sdm.js";

const GENERATE = "sdm.devices.commands.CameraLiveStream.GenerateRtspStream";
const EXTEND = "sdm.devices.commands.CameraLiveStream.ExtendRtspStream";

/**
 * Renew this long before expiry. Streams live ~5 minutes; a 90s margin leaves
 * room for one failed attempt and a retry before the stream actually lapses.
 */
const RENEW_MARGIN_MS = 90_000;
/** Floor on the renewal timer, so a bogus/near expiry cannot spin. */
const MIN_RENEW_DELAY_MS = 15_000;
/** Backoff after a failed renewal before regenerating from scratch. */
const RETRY_DELAY_MS = 20_000;
/** Longer backoff when SDM says 429 — the quota window must drain first. */
const RATE_LIMIT_DELAY_MS = 120_000;
/**
 * Minimum spacing between forced refreshes of the same camera. A forced
 * refresh mints a new stream, so an unhealthy camera must not be allowed to
 * ask for one every time the watchdog looks at it.
 */
const FORCE_REFRESH_COOLDOWN_MS = 300_000;

interface StreamState {
  deviceId: string;
  /** Stream URL as issued by SDM, including its `auth` token. */
  url: string;
  extensionToken: string;
  expiresAtMs: number;
  timer: NodeJS.Timeout | null;
  /** Generation counter — bumped whenever the URL changes. */
  epoch: number;
}

/**
 * Swap the `auth` query parameter for a freshly issued streamToken.
 *
 * SDM hands back the token separately from the URL on extension, and the URL
 * it originally issued carries the old one. Existing sessions do not care, but
 * a consumer that reconnects must present a current token.
 */
export function withAuthToken(url: string, token: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("auth", token);
    return parsed.toString();
  } catch {
    // Not a URL we can parse — hand it back untouched rather than break capture.
    return url;
  }
}

/**
 * Why a stream URL changed.
 *
 * `generated` means a brand new stream: any existing RTSP session for that
 * camera is dead, so consumers must be pointed at the new URL. `renewed`
 * means only the auth token rotated — established sessions keep flowing and
 * restarting them would cause an outage to apply a no-op.
 */
export type StreamChange = { cameraId: string; reason: "generated" | "renewed" };

export class NestStreamManager {
  private readonly streams = new Map<string, StreamState>();
  private readonly emitter = new Emitter<StreamChange>();
  private readonly lastForcedMs = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly bridge: NestBridge,
    private readonly log: Logger,
    /**
     * Paces the SDM calls this module makes. It has its own gate rather than
     * sharing the capture loops': once go2rtc consumes a managed URL, an
     * ffmpeg reconnect only touches the local restream and costs Google
     * nothing, so the only calls worth pacing are generate and extend.
     */
    private readonly gate: StreamStartGate = new StreamStartGate(3_000),
  ) {}

  /**
   * Reconcile live streams with the set of Nest cameras that should have one.
   * Acquires missing streams (paced) and releases streams for cameras that are
   * gone. Failures are logged, not thrown: one unreachable camera must not
   * stop the others from coming up.
   */
  async syncCameras(cameras: Array<{ id: string; deviceId: string }>): Promise<void> {
    if (this.stopped) return;
    const wanted = new Map(cameras.map((c) => [c.id, c.deviceId] as const));
    for (const cameraId of [...this.streams.keys()]) {
      if (!wanted.has(cameraId)) this.release(cameraId);
    }
    for (const [cameraId, deviceId] of wanted) {
      if (this.stopped) return;
      const existing = this.streams.get(cameraId);
      // A lapsed stream counts as missing. Renewal normally keeps this from
      // happening, but if that loop ever stops the reconcile is the only thing
      // that notices — checked against actual expiry rather than the renewal
      // margin, so it cannot race a renewal that is merely due.
      if (existing && existing.deviceId === deviceId && !this.isExpired(existing)) continue;
      try {
        await this.acquire(cameraId, deviceId);
      } catch (err) {
        this.log.warn(
          `could not acquire nest stream for camera ${cameraId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Fires whenever a camera's stream URL changes (callers re-render config). */
  onChange(listener: (change: StreamChange) => void): () => void {
    return this.emitter.on(listener);
  }

  /** Current RTSP URL for a camera, or null when none has been acquired yet. */
  urlFor(cameraId: string): string | null {
    return this.streams.get(cameraId)?.url ?? null;
  }

  /**
   * Ensure a live stream exists for this camera and return its URL.
   *
   * Reuses the existing stream whenever one is still comfortably valid, so
   * calling this on every reconnect costs nothing — which is the entire point.
   */
  async acquire(cameraId: string, deviceId: string): Promise<string> {
    if (this.stopped) throw new Error("stream manager stopped");
    const existing = this.streams.get(cameraId);
    if (existing && existing.deviceId === deviceId && !this.isStale(existing)) {
      return existing.url;
    }
    if (existing) this.release(cameraId);
    return this.generate(cameraId, deviceId);
  }

  /** Drop a camera's stream and stop renewing it. */
  release(cameraId: string): void {
    const state = this.streams.get(cameraId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.streams.delete(cameraId);
    this.lastForcedMs.delete(cameraId);
  }

  /** Stop renewing everything (shutdown). Streams lapse on their own. */
  stopAll(): void {
    this.stopped = true;
    for (const cameraId of [...this.streams.keys()]) this.release(cameraId);
  }

  /* ---------- internals ---------- */

  /**
   * Force a brand new stream for one camera, ignoring the one it holds.
   *
   * For the watchdog: when a camera has a stream the node believes is live but
   * is not recording, the usual suspect is go2rtc holding a URL whose token
   * rotated underneath it — go2rtc reads its config once at startup, so a
   * rotation it did not see leaves it unable to re-dial. Minting a new stream
   * emits `generated`, which restarts go2rtc against a current URL.
   */
  async refresh(cameraId: string, deviceId: string): Promise<boolean> {
    if (this.stopped) return false;
    const last = this.lastForcedMs.get(cameraId) ?? 0;
    // Returns false when the cooldown swallowed the request, so callers do not
    // announce a refresh that never happened.
    if (Date.now() - last < FORCE_REFRESH_COOLDOWN_MS) return false;
    // release() clears the cooldown map for the camera, so stamp it after.
    this.release(cameraId);
    this.lastForcedMs.set(cameraId, Date.now());
    try {
      await this.generate(cameraId, deviceId);
      return true;
    } catch (err) {
      this.log.warn(
        `forced nest stream refresh failed for camera ${cameraId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** Past its expiry — the stream is dead, not merely due for renewal. */
  private isExpired(state: StreamState): boolean {
    return state.expiresAtMs <= Date.now();
  }

  private isStale(state: StreamState): boolean {
    return state.expiresAtMs - Date.now() <= RENEW_MARGIN_MS;
  }

  private async generate(cameraId: string, deviceId: string): Promise<string> {
    await this.gate.acquire();
    const results = await this.bridge.executeCommand(deviceId, GENERATE);
    const urls = results.streamUrls as { rtspUrl?: string } | undefined;
    const url = urls?.rtspUrl;
    const extensionToken = results.streamExtensionToken;
    const expiresAt = results.expiresAt;
    if (typeof url !== "string" || typeof extensionToken !== "string" || typeof expiresAt !== "string") {
      throw new Error("SDM GenerateRtspStream returned an unexpected payload");
    }

    const previous = this.streams.get(cameraId);
    const state: StreamState = {
      deviceId,
      url,
      extensionToken,
      expiresAtMs: Date.parse(expiresAt),
      timer: null,
      epoch: (previous?.epoch ?? 0) + 1,
    };
    this.streams.set(cameraId, state);
    this.scheduleRenew(cameraId);
    this.log.info(
      `nest stream generated for camera ${cameraId} (expires in ` +
        `${Math.round((state.expiresAtMs - Date.now()) / 1000)}s)`,
    );
    this.emitter.emit({ cameraId, reason: "generated" });
    return url;
  }

  /** Background regeneration after a failed renewal; never throws. */
  private async regenerate(cameraId: string, deviceId: string): Promise<void> {
    if (this.stopped || !this.streams.has(cameraId)) return;
    try {
      await this.generate(cameraId, deviceId);
    } catch (err) {
      const rateLimited = err instanceof NestCommandError && err.isRateLimited;
      this.log.warn(
        `nest stream regeneration failed for camera ${cameraId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleRenew(cameraId, rateLimited ? RATE_LIMIT_DELAY_MS : RETRY_DELAY_MS);
    }
  }

  private scheduleRenew(cameraId: string, overrideMs?: number): void {
    const state = this.streams.get(cameraId);
    if (!state || this.stopped) return;
    if (state.timer) clearTimeout(state.timer);
    const delay =
      overrideMs ??
      Math.max(MIN_RENEW_DELAY_MS, state.expiresAtMs - Date.now() - RENEW_MARGIN_MS);
    state.timer = setTimeout(() => {
      // expiresAtMs === 0 marks a stream whose extension token SDM rejected;
      // extending it again would fail forever, so mint a new one instead.
      void (state.expiresAtMs === 0
        ? this.regenerate(cameraId, state.deviceId)
        : this.renew(cameraId));
    }, delay);
    state.timer.unref();
  }

  /**
   * Extend the stream in place. On success nothing downstream restarts — the
   * established RTSP session keeps flowing and only the token changes.
   */
  private async renew(cameraId: string): Promise<void> {
    const state = this.streams.get(cameraId);
    if (!state || this.stopped) return;
    try {
      const results = await this.bridge.executeCommand(state.deviceId, EXTEND, {
        streamExtensionToken: state.extensionToken,
      });
      const token = results.streamToken;
      const extensionToken = results.streamExtensionToken;
      const expiresAt = results.expiresAt;
      if (typeof token !== "string" || typeof extensionToken !== "string" || typeof expiresAt !== "string") {
        throw new Error("SDM ExtendRtspStream returned an unexpected payload");
      }
      state.extensionToken = extensionToken;
      state.expiresAtMs = Date.parse(expiresAt);
      const url = withAuthToken(state.url, token);
      const changed = url !== state.url;
      state.url = url;
      this.scheduleRenew(cameraId);
      // Only notify when the URL actually moved: consumers rewrite config on
      // this signal, and a needless rewrite would restart healthy captures.
      if (changed) this.emitter.emit({ cameraId, reason: "renewed" });
    } catch (err) {
      const rateLimited = err instanceof NestCommandError && err.isRateLimited;
      this.log.warn(
        `nest stream renewal failed for camera ${cameraId}: ` +
          `${err instanceof Error ? err.message : String(err)} — ` +
          `${rateLimited ? "rate limited, backing off" : "will regenerate"}`,
      );
      this.scheduleRenew(cameraId, rateLimited ? RATE_LIMIT_DELAY_MS : RETRY_DELAY_MS);
      // Force the next acquire() to mint a fresh stream.
      state.expiresAtMs = 0;
    }
  }
}
