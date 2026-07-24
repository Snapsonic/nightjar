import type { CameraConfig } from "@nightjar/shared";
import { Emitter } from "../emitter.js";
import type { Logger } from "../log.js";

export interface MotionEvent {
  cameraId: string;
  atMs: number;
  /** Fraction of pixels that changed vs the previous frame (0..1). */
  changedFraction: number;
  /** The low-res grayscale frame that triggered motion, for the detect worker. */
  frame?: Buffer;
}

/**
 * Motion detector — STUB.
 *
 * Intended design: for each enabled camera with detect=true, spawn ffmpeg on
 * the substream (fall back to main) decoding ~5 fps tiny grayscale frames:
 *
 *   ffmpeg -nostdin -rtsp_transport tcp -i <rtspSubUrl>
 *     -vf fps=5,scale=160:-2,format=gray -f rawvideo pipe:1
 *
 * Keep the previous frame; per-pixel absolute diff against a noise threshold;
 * emit a MotionEvent when the changed-pixel fraction stays above a trigger
 * threshold for N consecutive frames (debounce), with a cooldown before
 * re-triggering. Triggering frames are handed to the detect worker
 * (src/detect/worker.ts) for object classification.
 */
export class MotionDetector {
  private readonly emitter = new Emitter<MotionEvent>();
  private readonly running = new Set<string>();
  private warned = false;

  constructor(private readonly log: Logger) {}

  start(camera: CameraConfig): void {
    if (!this.warned) {
      this.log.info("motion: detection is not implemented yet (stub)");
      this.warned = true;
    }
    this.running.add(camera.id);
  }

  stop(cameraId: string): void {
    this.running.delete(cameraId);
  }

  stopAll(): void {
    this.running.clear();
  }

  /** Subscribe to motion events. Returns an unsubscribe function. */
  onMotion(listener: (event: MotionEvent) => void): () => void {
    return this.emitter.on(listener);
  }
}
