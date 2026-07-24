import type { NvrEvent } from "@nightjar/shared";
import type { Json } from "@nightjar/db";
import type { CloudLink } from "../cloud/link.js";
import type { NodeDb } from "../db.js";
import type { Logger } from "../log.js";
import type { MotionDetector, MotionEvent } from "../motion/detector.js";

/**
 * Event pipeline — STUB (postEvent is real).
 *
 * Intended design: motion events from the detector are merged into NvrEvents
 * with a merge window (motion within ~30s of an open event extends it rather
 * than opening a new one). While an event is open, triggering frames go to the
 * detect worker to upgrade kind from "motion" to person/vehicle/animal/package
 * (keep the max score). On close: cut a clip from the recorder's segments
 * (exportRange), grab a thumbnail via go2rtc /api/frame.jpeg, request signed
 * upload URLs from the sign-upload edge function ({eventId, files:
 * ["clip.mp4","thumb.jpg"]}), upload via uploadToSignedUrl, then update the
 * events row clip_status local -> uploading -> uploaded. Failed uploads sit in
 * the upload_queue table and are retried with backoff.
 */
export class EventPipeline {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly deps: {
      db: NodeDb;
      link: CloudLink;
      log: Logger;
    },
  ) {}

  attach(detector: MotionDetector): void {
    this.unsubscribe = detector.onMotion((event: MotionEvent) => {
      // TODO(events): merge into an open NvrEvent per the design above.
      this.deps.log.debug(`motion on camera ${event.cameraId} (unhandled — pipeline is a stub)`);
    });
  }

  /**
   * Persist an event locally and, when the cloud link is up, insert it into
   * the cloud events table. Used by the pipeline once it produces real events.
   */
  async postEvent(event: NvrEvent): Promise<void> {
    this.deps.db.insertEvent(event);
    const client = this.deps.link.getClient();
    const nodeId = this.deps.link.getNodeId();
    if (!client || !nodeId) return;
    const { error } = await client.from("events").insert({
      id: event.id,
      node_id: nodeId,
      camera_id: event.cameraId,
      kind: event.kind,
      score: event.score,
      started_at: event.startedAt,
      ended_at: event.endedAt ?? null,
      clip_status: event.clipStatus,
      thumbnail_path: event.thumbnailPath ?? null,
      metadata: JSON.parse(JSON.stringify(event.metadata)) as Json,
    });
    if (error) this.deps.log.warn(`cloud event insert failed: ${error.message}`);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
