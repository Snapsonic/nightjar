import type { CameraConfig } from "@nightjar/shared";
import type { ConfigStore } from "../config/store.js";
import type { NodeDb, SegmentRow } from "../db.js";
import type { Logger } from "../log.js";

export interface ExportResult {
  /** Absolute path of the exported mp4. */
  path: string;
}

/**
 * Continuous recorder — WALKING SKELETON.
 *
 * The interface and the `segments` SQLite index are real; the actual ffmpeg
 * capture lands next milestone. Intended design per camera with record=true:
 *
 *   // TODO(recording): spawn one long-lived ffmpeg per camera:
 *   //   ffmpeg -nostdin -rtsp_transport tcp -i <camera.rtspUrl> \
 *   //     -c copy -an? (keep audio when present) \
 *   //     -f segment -segment_time 10 -reset_timestamps 1 -strftime 1 \
 *   //     -segment_format mp4 -segment_format_options movflags=+frag_keyframe+empty_moov \
 *   //     <recordingsDir>/<cameraId>/%Y%m%d-%H%M%S.mp4
 *   // On each finished segment (fs watch or -progress pipe): insertSegment /
 *   // endSegment rows so segmentsBetween() can serve timeline playback.
 *   // Supervise the child: restart with backoff on exit; stop() kills it.
 *   // Retention: prune oldest segments past retention.maxDays or when disk
 *   // usage crosses retention.diskHighWatermark.
 */
export class Recorder {
  private readonly active = new Set<string>();
  private warned = false;

  constructor(
    private readonly db: NodeDb,
    private readonly store: ConfigStore,
    private readonly log: Logger,
  ) {}

  start(camera: CameraConfig): void {
    if (!this.warned) {
      this.log.info("recorder: continuous recording is not implemented yet (stub)");
      this.warned = true;
    }
    this.active.add(camera.id);
  }

  stop(cameraId: string): void {
    this.active.delete(cameraId);
  }

  stopAll(): void {
    this.active.clear();
  }

  /** True once real recording exists; the stub never actually records. */
  isRecording(_cameraId: string): boolean {
    return false;
  }

  /** Segments overlapping [t0Ms, t1Ms) — served from the SQLite index. */
  segmentsBetween(cameraId: string, t0Ms: number, t1Ms: number): SegmentRow[] {
    return this.db.segmentsBetween(cameraId, t0Ms, t1Ms);
  }

  /**
   * Export a continuous clip covering [t0Ms, t1Ms).
   * TODO(recording): concat-demuxer over segmentsBetween() + -ss/-to trim:
   *   ffmpeg -f concat -safe 0 -i <list.txt> -ss <offset> -to <end> -c copy <outPath>
   */
  async exportRange(cameraId: string, t0Ms: number, t1Ms: number, outPath: string): Promise<ExportResult> {
    void cameraId;
    void t0Ms;
    void t1Ms;
    void outPath;
    void this.store;
    throw new Error("exportRange not implemented — recording lands next milestone");
  }
}
