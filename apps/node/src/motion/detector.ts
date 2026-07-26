import { spawn, type ChildProcess } from "node:child_process";
import type { CameraConfig } from "@nightjar/shared";
import { jitterMs, SPAWN_STAGGER_MS, StreamBreaker, StreamStartGate } from "../backoff.js";
import { captureSubUrl } from "../cameras/streams.js";
import { Emitter } from "../emitter.js";
import { rtspInputArgs } from "../ffmpeg.js";
import type { ConfigStore } from "../config/store.js";
import type { Logger } from "../log.js";
import { buildZoneMasks, diffFrame, topZoneId, type ZoneMasks } from "./zones.js";

/** Analysis frame geometry — tiny grayscale frames off the substream. */
export const FRAME_WIDTH = 320;
export const FRAME_HEIGHT = 180;
const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT;

const FPS = 5;
/** Per-pixel |frame - background| above this counts as changed. */
const PIXEL_THRESHOLD = 25;
/** Fraction of changed pixels above this makes the frame a motion frame. */
const TRIGGER_FRACTION = 0.015;
/** Consecutive motion frames required before motionStart fires. */
const START_FRAMES = 2;
/** motionEnd fires after this long without a motion frame. */
const QUIET_MS = 10_000;
/** Background learning rate: bg = bg*(1-ALPHA) + frame*ALPHA. */
const ALPHA = 0.05;

const BACKOFF_START_MS = 1_000;
// Patient cap: every reconnect asks Google to generate a new SDM stream, and
// SDM rate-limits per minute — a tight retry herd (5 cams x 2 consumers at
// 15s) never lets the quota recover. Success still resets to 1s via STABLE_MS.
const BACKOFF_CAP_MS = 300_000;
const STABLE_MS = 30_000;
const KILL_GRACE_MS = 3_000;

export type MotionEvent =
  | {
      type: "start";
      cameraId: string;
      atMs: number;
      /** Fraction of active (zone-masked) pixels that differ from the rolling
       *  background (0..1). Without zones the whole frame is active. */
      changedFraction: number;
      /** Zone whose mask had the most changed pixels at trigger time; absent
       *  when the camera has no zones configured. */
      zoneId?: string;
    }
  | { type: "end"; cameraId: string; atMs: number };

interface CameraMotion {
  camera: CameraConfig;
  proc: ChildProcess | null;
  stopping: boolean;
  backoffMs: number;
  restartTimer: NodeJS.Timeout | null;
  quietTimer: NodeJS.Timeout | null;
  spawnedAt: number;
  /** Reused frame accumulation buffer (no per-frame allocation). */
  frame: Buffer;
  fill: number;
  bg: Float32Array | null;
  /** Zone masks at analysis resolution; rebuilt when the zones config changes. */
  masks: ZoneMasks;
  consecutive: number;
  active: boolean;
  lastMotionMs: number;
  stderrTail: string;
}

/**
 * Motion detector. For each enabled camera with detect=true, one ffmpeg
 * decodes the substream (fallback: main) into 5 fps 320x180 grayscale raw
 * frames on stdout. A rolling background (bg = bg*0.95 + frame*0.05) is
 * compared per pixel; a frame is "motion" when >1.5% of active pixels differ
 * by more than 25. "Active" = inside the union of the camera's activity-zone
 * masks (rasterized at 320x180, rebuilt on config change); with no zones the
 * whole frame is active. motionStart after 2 consecutive motion frames (the event
 * pipeline then pulls a full-color go2rtc snapshot for object detection —
 * these gray analysis frames are too small/colorless for that); motionEnd
 * after 10s quiet.
 * Crashed decoders restart with exponential backoff (cap 60s).
 */
export class MotionDetector {
  private readonly emitter = new Emitter<MotionEvent>();
  private readonly running = new Map<string, CameraMotion>();
  private readonly unsubscribe: () => void;
  private stopped = false;

  constructor(
    private readonly store: ConfigStore,
    private readonly log: Logger,
    /** Shared with the recorder — see Recorder's constructor. */
    private readonly breaker: StreamBreaker = new StreamBreaker(),
    /** Shared with the recorder — see Recorder's constructor. */
    private readonly gate: StreamStartGate = new StreamStartGate(),
  ) {
    this.unsubscribe = this.store.onChange(() => this.sync());
  }

  /* ---------- lifecycle ---------- */

  /** Reconcile running decoders with the current config. */
  sync(): void {
    if (this.stopped) return;
    const wanted = new Map(
      this.store
        .get()
        .cameras.filter((c) => c.enabled && c.detect)
        .map((c) => [c.id, c] as const),
    );
    for (const [cameraId, cam] of [...this.running]) {
      const camera = wanted.get(cameraId);
      if (!camera) {
        this.stop(cameraId);
      } else if (this.streamUrl(camera) !== this.streamUrl(cam.camera)) {
        this.log.info(`camera ${cameraId} URL changed — restarting motion decoder`);
        this.stop(cameraId);
        this.start(camera);
      } else {
        const zonesChanged = JSON.stringify(camera.zones) !== JSON.stringify(cam.camera.zones);
        cam.camera = camera;
        if (zonesChanged) this.rebuildMasks(cam);
      }
    }
    let index = 0;
    for (const camera of wanted.values()) {
      // Stagger fresh spawns by camera index so a node (re)start doesn't herd
      // every decoder onto the upstream at once.
      if (!this.running.has(camera.id)) this.start(camera, index * SPAWN_STAGGER_MS);
      index++;
    }
  }

  start(camera: CameraConfig, delayMs = 0): void {
    if (this.stopped || this.running.has(camera.id)) return;
    const cam: CameraMotion = {
      camera,
      proc: null,
      stopping: false,
      backoffMs: BACKOFF_START_MS,
      restartTimer: null,
      quietTimer: null,
      spawnedAt: 0,
      frame: Buffer.allocUnsafe(FRAME_BYTES),
      fill: 0,
      bg: null,
      masks: buildZoneMasks(camera.zones, FRAME_WIDTH, FRAME_HEIGHT),
      consecutive: 0,
      active: false,
      lastMotionMs: 0,
      stderrTail: "",
    };
    this.logMasks(cam);
    this.running.set(camera.id, cam);
    if (delayMs > 0) {
      cam.restartTimer = setTimeout(() => {
        cam.restartTimer = null;
        this.spawn(cam);
      }, delayMs);
      cam.restartTimer.unref();
    } else {
      this.spawn(cam);
    }
    // Safety net: end motion even if the stream stalls without exiting.
    cam.quietTimer = setInterval(() => this.checkQuiet(cam), 2_000);
    cam.quietTimer.unref();
    this.log.info(
      `motion detection started for camera ${camera.id} ("${camera.name}")` +
        (delayMs > 0 ? ` — first spawn in ${Math.round(delayMs / 1000)}s` : ""),
    );
  }

  stop(cameraId: string): void {
    const cam = this.running.get(cameraId);
    if (!cam) return;
    this.running.delete(cameraId);
    cam.stopping = true;
    if (cam.restartTimer) clearTimeout(cam.restartTimer);
    if (cam.quietTimer) clearInterval(cam.quietTimer);
    this.killProcess(cam);
    this.endMotion(cam);
    this.log.info(`motion detection stopped for camera ${cameraId}`);
  }

  /** Stop everything; resolves once every child has exited (or the kill-grace cap). */
  async stopAll(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    const procs = [...this.running.values()]
      .map((cam) => cam.proc)
      .filter((proc): proc is ChildProcess => proc !== null);
    for (const cameraId of [...this.running.keys()]) this.stop(cameraId);
    await Promise.all(
      procs.map(
        (proc) =>
          new Promise<void>((resolve) => {
            if (proc.exitCode !== null || proc.signalCode !== null) {
              resolve();
              return;
            }
            const cap = setTimeout(resolve, KILL_GRACE_MS);
            cap.unref();
            proc.once("exit", () => {
              clearTimeout(cap);
              resolve();
            });
          }),
      ),
    );
  }

  /** Subscribe to motion events. Returns an unsubscribe function. */
  onMotion(listener: (event: MotionEvent) => void): () => void {
    return this.emitter.on(listener);
  }

  /* ---------- decoding ---------- */

  private spawn(cam: CameraMotion): void {
    void this.gate.acquire().then(() => {
      if (cam.stopping || this.stopped) return;
      this.spawnNow(cam);
    });
  }

  private spawnNow(cam: CameraMotion): void {
    if (cam.stopping || this.stopped) return;
    // prettier-ignore
    const args = [
      ...rtspInputArgs(this.streamUrl(cam.camera)),
      "-vf", `fps=${FPS},scale=${FRAME_WIDTH}:${FRAME_HEIGHT},format=gray`,
      "-f", "rawvideo",
      "-",
    ];
    const proc = spawn("ffmpeg", args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    cam.proc = proc;
    cam.spawnedAt = Date.now();
    cam.fill = 0;
    cam.bg = null;
    cam.consecutive = 0;
    cam.stderrTail = "";
    proc.stdout?.on("data", (chunk: Buffer) => this.consume(cam, chunk));
    proc.stderr?.on("data", (chunk: Buffer) => {
      cam.stderrTail = (cam.stderrTail + chunk.toString()).slice(-2000);
    });
    proc.on("error", (err) => {
      this.log.error(`ffmpeg spawn failed for camera ${cam.camera.id}: ${err.message}`);
    });
    proc.on("exit", (code, signal) => {
      if (cam.proc !== proc) return;
      cam.proc = null;
      this.endMotion(cam);
      if (cam.stopping || this.stopped) return;
      if (Date.now() - cam.spawnedAt > STABLE_MS) {
        cam.backoffMs = BACKOFF_START_MS;
        this.breaker.recordSuccess();
      } else {
        this.breaker.recordFailure();
      }
      const delayMs = Math.max(jitterMs(cam.backoffMs), this.breaker.waitMs());
      const tail = cam.stderrTail.trim().split("\n").pop() ?? "";
      this.log.warn(
        `motion ffmpeg for camera ${cam.camera.id} exited (code=${code} signal=${signal})` +
          `${tail ? ` — ${tail}` : ""} — restarting in ${Math.round(delayMs / 1000)}s`,
      );
      cam.restartTimer = setTimeout(() => {
        cam.restartTimer = null;
        this.spawn(cam);
      }, delayMs);
      cam.restartTimer.unref();
      cam.backoffMs = Math.min(cam.backoffMs * 2, BACKOFF_CAP_MS);
    });
  }

  private killProcess(cam: CameraMotion): void {
    const proc = cam.proc;
    if (!proc || proc.pid === undefined) return;
    const pid = proc.pid;
    try {
      process.kill(-pid, "SIGTERM"); // whole process group
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    const hardKill = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, KILL_GRACE_MS);
    hardKill.unref();
    proc.once("exit", () => clearTimeout(hardKill));
  }

  /** Reassemble fixed-size frames from the raw stdout byte stream. */
  private consume(cam: CameraMotion, chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(FRAME_BYTES - cam.fill, chunk.length - offset);
      chunk.copy(cam.frame, cam.fill, offset, offset + take);
      cam.fill += take;
      offset += take;
      if (cam.fill === FRAME_BYTES) {
        cam.fill = 0;
        this.processFrame(cam);
      }
    }
  }

  private processFrame(cam: CameraMotion): void {
    const frame = cam.frame;
    if (cam.bg === null) {
      const bg = new Float32Array(FRAME_BYTES);
      for (let i = 0; i < FRAME_BYTES; i++) bg[i] = frame[i] as number;
      cam.bg = bg;
      return;
    }
    const diff = diffFrame(frame, cam.bg, cam.masks, PIXEL_THRESHOLD, ALPHA);
    const now = Date.now();
    if (diff.changedFraction > TRIGGER_FRACTION) {
      cam.consecutive++;
      cam.lastMotionMs = now;
      if (!cam.active && cam.consecutive >= START_FRAMES) {
        cam.active = true;
        const zoneId = topZoneId(diff.perZoneChanged);
        this.emitter.emit({
          type: "start",
          cameraId: cam.camera.id,
          atMs: now,
          changedFraction: diff.changedFraction,
          ...(zoneId !== null ? { zoneId } : {}),
        });
      }
    } else {
      cam.consecutive = 0;
      if (cam.active && now - cam.lastMotionMs >= QUIET_MS) this.endMotion(cam);
    }
  }

  /* ---------- activity zone masks ---------- */

  /** Re-rasterize the camera's zone masks (config change, decoder untouched). */
  private rebuildMasks(cam: CameraMotion): void {
    cam.masks = buildZoneMasks(cam.camera.zones, FRAME_WIDTH, FRAME_HEIGHT);
    this.logMasks(cam, "rebuilt");
  }

  private logMasks(cam: CameraMotion, verb = "built"): void {
    const zones = cam.camera.zones;
    this.log.info(
      `motion mask ${verb} for camera ${cam.camera.id}: ` +
        (zones.length === 0
          ? `no zones — full frame active (${FRAME_BYTES} px)`
          : `${zones.length} zone(s), ${cam.masks.activeCount}/${FRAME_BYTES} px active`),
    );
  }

  /** Substream when configured, else the main stream (go2rtc restream for nest). */
  private streamUrl(camera: CameraConfig): string {
    return captureSubUrl(this.store.get(), camera);
  }

  private checkQuiet(cam: CameraMotion): void {
    if (cam.active && Date.now() - cam.lastMotionMs >= QUIET_MS) this.endMotion(cam);
  }

  private endMotion(cam: CameraMotion): void {
    if (!cam.active) return;
    cam.active = false;
    cam.consecutive = 0;
    this.emitter.emit({ type: "end", cameraId: cam.camera.id, atMs: Date.now() });
  }
}
