import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  SignUploadResponse,
  type Detection,
  type EventKind,
  type NvrEvent,
} from "@nightjar/shared";
import type { Json } from "@nightjar/db";
import type { GdriveBackup } from "../backup/gdrive.js";
import type { CloudLink } from "../cloud/link.js";
import type { ConfigStore } from "../config/store.js";
import type { NodeDb } from "../db.js";
import { go2rtcStreamName } from "@nightjar/shared";
import type { DetectWorker } from "../detect/worker.js";
import type { Logger } from "../log.js";
import type { MotionDetector, MotionEvent } from "../motion/detector.js";
import { detectionInZones, zoneIdsForBox } from "../motion/zones.js";
import type { Recorder } from "../recorder/recorder.js";

const execFileAsync = promisify(execFile);

/** Clip padding around the motion episode. */
const PRE_ROLL_MS = 5_000;
const POST_ROLL_MS = 5_000;
/** go2rtc snapshot fetch budget — on timeout the event simply stays "motion". */
const SNAPSHOT_TIMEOUT_MS = 2_000;
/** Detections below this score are discarded by the pipeline. */
const MIN_DETECTION_SCORE = 0.5;
/** One extra detection pass this long after motionStart (if still open). */
const REDETECT_DELAY_MS = 10_000;
/** Event kind upgrade priority — higher wins regardless of score. */
const KIND_PRIORITY: Record<EventKind, number> = {
  person: 5,
  bear: 4,
  package: 3,
  vehicle: 2,
  animal: 1,
  motion: 0,
};
/** Extra wait before cutting so the post-roll footage exists on disk. */
const CLOSE_SLACK_MS = 2_000;
/** Bounded offline queue — oldest jobs beyond this are dropped. */
const MAX_QUEUED_UPLOADS = 500;
const UPLOAD_IDLE_MS = 10_000;
const UPLOAD_BACKOFF_BASE_MS = 5_000;
const UPLOAD_BACKOFF_CAP_MS = 300_000;
/** Serial queue: a permanently failing job must not block everything behind it. */
const UPLOAD_MAX_ATTEMPTS = 50;
const CLIP_EXPIRY_MS = 3 * 86_400_000;

interface OpenEvent {
  id: string;
  cameraId: string;
  kind: EventKind;
  score: number;
  startedAtMs: number;
  endedAtMs: number | null;
  changedFraction: number;
  detections: Detection[];
  /** Zones that triggered: detection centers first, motion-mask attribution
   *  for motion-only events. Empty when the camera has no zones. */
  zoneIds: Set<string>;
  closeTimer: NodeJS.Timeout | null;
  redetectTimer: NodeJS.Timeout | null;
}

export interface EventPipelineDeps {
  db: NodeDb;
  link: CloudLink;
  recorder: Recorder;
  detect: DetectWorker;
  store: ConfigStore;
  /** Optional "bring your own cloud" backup — enqueues alongside the cloud upload. */
  gdrive?: GdriveBackup;
  log: Logger;
}

/**
 * Motion -> event -> clip -> upload pipeline.
 *
 * motionStart opens a candidate event (kind "motion", score 0.5), grabs a
 * full-color JPEG snapshot from go2rtc (the 320x180 grayscale motion frame is
 * too small/colorless for detection) and hands it to the detect worker
 * (YOLOX-tiny), which may upgrade kind/score; a second pass runs 10s in if
 * the event is still open. motionEnd schedules the close: clip bounds are start-5s .. end+5s (clamped
 * to now); the clip is cut from the recorder's segments, a mid-clip 640w jpeg
 * thumbnail is extracted, the event row is written to SQLite and an upload
 * job is enqueued. A serial uploader worker (survives restarts via the
 * upload_queue table, retries with backoff, bounded to the newest 500 jobs)
 * pushes the event row, signed-URL uploads and the event_clips row to the
 * cloud whenever the link is up; offline, jobs simply stay queued.
 */
export class EventPipeline {
  private unsubscribe: (() => void) | null = null;
  private readonly open = new Map<string, OpenEvent>();
  private running = true;
  private uploaderLoop: Promise<void> | null = null;
  private readonly wakers = new Set<() => void>();

  constructor(private readonly deps: EventPipelineDeps) {}

  attach(detector: MotionDetector): void {
    this.unsubscribe = detector.onMotion((event) => this.onMotion(event));
    this.uploaderLoop = this.runUploader().catch((err) => {
      this.deps.log.error(`uploader crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  stop(): void {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const open of this.open.values()) {
      if (open.closeTimer) clearTimeout(open.closeTimer);
      if (open.redetectTimer) clearTimeout(open.redetectTimer);
    }
    this.open.clear();
    for (const wake of [...this.wakers]) wake();
    void this.uploaderLoop;
  }

  /* ---------- motion handling ---------- */

  private onMotion(event: MotionEvent): void {
    if (!this.running) return;
    if (event.type === "start") {
      const existing = this.open.get(event.cameraId);
      if (existing) {
        // Motion resumed while the close was pending — extend the same event.
        if (existing.closeTimer) {
          clearTimeout(existing.closeTimer);
          existing.closeTimer = null;
          existing.endedAtMs = null;
        }
        if (event.zoneId !== undefined) existing.zoneIds.add(event.zoneId);
        void this.runDetect(existing);
        return;
      }
      const candidate: OpenEvent = {
        id: randomUUID(),
        cameraId: event.cameraId,
        kind: "motion",
        score: 0.5,
        startedAtMs: event.atMs,
        endedAtMs: null,
        changedFraction: event.changedFraction,
        detections: [],
        zoneIds: new Set(event.zoneId !== undefined ? [event.zoneId] : []),
        closeTimer: null,
        redetectTimer: null,
      };
      this.open.set(event.cameraId, candidate);
      this.deps.log.info(
        `motion started on camera ${event.cameraId} (${(event.changedFraction * 100).toFixed(1)}% changed) — event ${candidate.id}`,
      );
      void this.runDetect(candidate);
      // One more pass mid-event to catch subjects that enter after the trigger.
      candidate.redetectTimer = setTimeout(() => {
        candidate.redetectTimer = null;
        if (this.open.get(event.cameraId) === candidate) void this.runDetect(candidate);
      }, REDETECT_DELAY_MS);
      candidate.redetectTimer.unref();
    } else {
      const candidate = this.open.get(event.cameraId);
      if (!candidate || candidate.closeTimer) return;
      candidate.endedAtMs = event.atMs;
      // Wait until the post-roll footage exists on disk before cutting.
      candidate.closeTimer = setTimeout(() => {
        this.open.delete(event.cameraId);
        if (candidate.redetectTimer) {
          clearTimeout(candidate.redetectTimer);
          candidate.redetectTimer = null;
        }
        void this.close(candidate).catch((err) => {
          this.deps.log.error(
            `event ${candidate.id} close failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, POST_ROLL_MS + CLOSE_SLACK_MS);
    }
  }

  /**
   * Full-color JPEG of the camera's live main stream via go2rtc — the
   * 320x180 grayscale motion frames are unusable for object detection.
   * Returns null on any failure (the event then simply stays "motion").
   */
  private async fetchSnapshot(cameraId: string): Promise<Buffer | null> {
    const apiUrl = this.deps.store.get().go2rtc.apiUrl.replace(/\/+$/, "");
    const src = encodeURIComponent(go2rtcStreamName(cameraId));
    try {
      const res = await fetch(`${apiUrl}/api/frame.jpeg?src=${src}`, {
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.deps.log.warn(`detect snapshot for camera ${cameraId}: HTTP ${res.status}`);
        return null;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      this.deps.log.warn(
        `detect snapshot for camera ${cameraId} failed: ${err instanceof Error ? err.message : String(err)} — event stays "motion"`,
      );
      return null;
    }
  }

  /** Snapshot -> detect worker -> zone filter -> merge detections and upgrade
   *  kind/score. With zones configured, a detection only counts when its box
   *  center falls inside a zone polygon. */
  private async runDetect(candidate: OpenEvent): Promise<void> {
    try {
      const jpeg = await this.fetchSnapshot(candidate.cameraId);
      if (!jpeg) return;
      const zones =
        this.deps.store.get().cameras.find((c) => c.id === candidate.cameraId)?.zones ?? [];
      const scored = (await this.deps.detect.detect(jpeg)).filter(
        (d) => d.score >= MIN_DETECTION_SCORE,
      );
      const detections = scored.filter((d) => detectionInZones(d, zones));
      const dropped = scored.length - detections.length;
      if (dropped > 0) {
        this.deps.log.info(
          `event ${candidate.id}: ${dropped} detection(s) outside activity zones ignored`,
        );
      }
      if (detections.length === 0) return;
      for (const detection of detections) {
        if (detection.box) {
          for (const zoneId of zoneIdsForBox(detection.box, zones)) candidate.zoneIds.add(zoneId);
        }
      }
      candidate.detections.push(...detections);
      for (const detection of detections) {
        if (KIND_PRIORITY[detection.kind] > KIND_PRIORITY[candidate.kind]) {
          candidate.kind = detection.kind;
        }
        candidate.score = Math.max(candidate.score, detection.score);
      }
      this.deps.log.info(
        `event ${candidate.id}: detected ${detections
          .map((d) => `${d.kind} ${(d.score * 100).toFixed(0)}%`)
          .join(", ")} — kind ${candidate.kind}`,
      );
    } catch (err) {
      this.deps.log.warn(`detect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* ---------- event close: clip + thumbnail + row + queue ---------- */

  private clipDir(eventId: string): string {
    return path.join(this.deps.store.get().paths.recordings, ".clips", eventId);
  }

  private async close(candidate: OpenEvent): Promise<void> {
    const endMs = candidate.endedAtMs ?? Date.now();
    const clipStartMs = candidate.startedAtMs - PRE_ROLL_MS;
    const clipEndMs = Math.min(endMs + POST_ROLL_MS, Date.now());

    const dir = this.clipDir(candidate.id);
    const clipPath = path.join(dir, "clip.mp4");
    const thumbPath = path.join(dir, "thumb.jpg");
    let hasClip = false;
    try {
      mkdirSync(dir, { recursive: true });
      await this.deps.recorder.exportRange(candidate.cameraId, clipStartMs, clipEndMs, clipPath);
      await this.extractThumbnail(clipPath, thumbPath);
      hasClip = true;
    } catch (err) {
      this.deps.log.warn(
        `event ${candidate.id}: clip export failed (${err instanceof Error ? err.message : String(err)}) — keeping event without clip`,
      );
      rmSync(dir, { recursive: true, force: true });
    }

    const event: NvrEvent = {
      id: candidate.id,
      cameraId: candidate.cameraId,
      kind: candidate.kind,
      score: candidate.score,
      startedAt: new Date(candidate.startedAtMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      clipStatus: "local",
      ...(hasClip ? { thumbnailPath: thumbPath } : {}),
      metadata: {
        changedFraction: candidate.changedFraction,
        detections: candidate.detections,
        ...(candidate.zoneIds.size > 0 ? { zoneIds: [...candidate.zoneIds] } : {}),
        ...(hasClip ? { clipStartMs, clipEndMs, durationS: (clipEndMs - clipStartMs) / 1000 } : {}),
      },
    };
    this.deps.db.insertEvent(event);
    this.deps.log.info(
      `event ${event.id} closed (${event.kind}, ${((clipEndMs - clipStartMs) / 1000).toFixed(1)}s${hasClip ? ", clip ready" : ", no clip"})`,
    );

    if (hasClip) {
      this.deps.db.enqueueUpload(event.id, dir);
      // Google Drive backup shares the same clip dir via its own queue —
      // enqueued only when enabled+connected right now (forward-only).
      this.deps.gdrive?.enqueueIfActive(event.id, dir);
      for (const dropped of this.deps.db.trimUploadQueue(MAX_QUEUED_UPLOADS)) {
        // The Drive queue may still need the clip files — delete only when
        // no queue references the event any more.
        if (!this.deps.db.clipReferenced(dropped.event_id)) {
          rmSync(dropped.file, { recursive: true, force: true });
        }
        this.deps.log.warn(`upload queue full — dropped event ${dropped.event_id}`);
      }
      this.kickUploader();
    }
  }

  /** Single frame from the clip midpoint (probed duration), scaled to 640w. */
  private async extractThumbnail(clipPath: string, thumbPath: string): Promise<void> {
    let midS = 0;
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clipPath],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
      );
      const duration = Number(stdout.trim());
      if (Number.isFinite(duration) && duration > 0) midS = duration / 2;
    } catch {
      // fall back to the first frame
    }
    // prettier-ignore
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin", "-loglevel", "error", "-y",
        "-ss", midS.toFixed(3),
        "-i", clipPath,
        "-frames:v", "1",
        "-vf", "scale=640:-2",
        "-q:v", "4",
        thumbPath,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
  }

  /* ---------- uploader worker ---------- */

  private kickUploader(): void {
    for (const wake of [...this.wakers]) wake();
  }

  /** Interruptible sleep — resolves early on stop()/kickUploader(). */
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

  private async runUploader(): Promise<void> {
    while (this.running) {
      const job = this.deps.db.nextUpload();
      if (!job) {
        await this.sleep(UPLOAD_IDLE_MS);
        continue;
      }
      if (!this.deps.link.getClient()) {
        // Cloud unlinked/offline — leave the job queued and check again later.
        await this.sleep(UPLOAD_IDLE_MS);
        continue;
      }
      try {
        await this.uploadEvent(job.event_id, job.file);
        this.deps.db.deleteUpload(job.id);
        // The clip dir is shared with the Google Drive backup queue — delete
        // it only once neither queue references the event.
        if (!this.deps.db.clipReferenced(job.event_id)) {
          rmSync(job.file, { recursive: true, force: true });
        }
        this.deps.log.info(`event ${job.event_id} uploaded`);
      } catch (err) {
        this.deps.db.bumpUploadAttempts(job.id);
        // Dead-letter poisoned jobs: the queue is serial, so one job that can
        // never succeed blocks every event behind it forever.
        if (job.attempts + 1 >= UPLOAD_MAX_ATTEMPTS) {
          this.deps.log.error(
            `upload of event ${job.event_id} abandoned after ${job.attempts + 1} attempts: ` +
              `${err instanceof Error ? err.message : String(err)} — clip stays local`,
          );
          this.deps.db.updateEventClipStatus(job.event_id, "local");
          this.deps.db.deleteUpload(job.id);
          if (!this.deps.db.clipReferenced(job.event_id)) {
            rmSync(job.file, { recursive: true, force: true });
          }
          continue;
        }
        const backoff = Math.min(
          UPLOAD_BACKOFF_BASE_MS * 2 ** Math.min(job.attempts, 10),
          UPLOAD_BACKOFF_CAP_MS,
        );
        this.deps.log.warn(
          `upload of event ${job.event_id} failed (attempt ${job.attempts + 1}): ` +
            `${err instanceof Error ? err.message : String(err)} — retrying in ${Math.round(backoff / 1000)}s`,
        );
        await this.sleep(backoff);
      }
    }
  }

  /** One full event upload: cloud row, signed URLs, files, clip row, status. */
  private async uploadEvent(eventId: string, dir: string): Promise<void> {
    const client = this.deps.link.getClient();
    const nodeId = this.deps.link.getNodeId();
    if (!client || !nodeId) throw new Error("cloud session not ready");
    const row = this.deps.db.getEvent(eventId);
    if (!row) throw new Error(`event ${eventId} missing locally`);
    const clipPath = path.join(dir, "clip.mp4");
    const thumbPath = path.join(dir, "thumb.jpg");
    const clipBytes = statSync(clipPath).size;
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;

    // (a) event row (upsert — retries must be idempotent)
    this.deps.db.updateEventClipStatus(eventId, "uploading");
    const { error: eventError } = await client.from("events").upsert({
      id: row.id,
      node_id: nodeId,
      camera_id: row.camera_id,
      kind: row.kind,
      score: row.score,
      started_at: row.started_at,
      ended_at: row.ended_at,
      clip_status: "uploading",
      metadata: metadata as Json,
    });
    if (eventError) throw new Error(`cloud event insert: ${eventError.message}`);

    // (b) signed upload URLs from the sign-upload edge function
    const { data: signData, error: signError } = await client.functions.invoke("sign-upload", {
      body: { eventId, files: ["clip.mp4", "thumb.jpg"] },
    });
    if (signError) throw new Error(`sign-upload: ${signError.message}`);
    const uploads = SignUploadResponse.parse(signData).uploads;
    const clipUpload = uploads.find((u) => u.file === "clip.mp4");
    const thumbUpload = uploads.find((u) => u.file === "thumb.jpg");
    if (!clipUpload || !thumbUpload) throw new Error("sign-upload response missing files");

    // (c) upload both files to the signed URLs
    for (const [upload, filePath, contentType] of [
      [clipUpload, clipPath, "video/mp4"],
      [thumbUpload, thumbPath, "image/jpeg"],
    ] as const) {
      const { error } = await client.storage
        .from("event-clips")
        .uploadToSignedUrl(upload.path, upload.token, readFileSync(filePath), {
          contentType,
          upsert: true,
        });
      if (error) throw new Error(`upload ${upload.file}: ${error.message}`);
    }

    // (d) event_clips row
    const durationS =
      typeof metadata.durationS === "number"
        ? metadata.durationS
        : Math.max(
            0,
            (Date.parse(row.ended_at ?? row.started_at) - Date.parse(row.started_at)) / 1000,
          );
    const { error: clipRowError } = await client.from("event_clips").upsert(
      {
        event_id: eventId,
        storage_path: clipUpload.path,
        bytes: clipBytes,
        duration_s: durationS,
        expires_at: new Date(Date.now() + CLIP_EXPIRY_MS).toISOString(),
      },
      { onConflict: "event_id" },
    );
    if (clipRowError) throw new Error(`event_clips insert: ${clipRowError.message}`);

    // (e) final status
    const { error: statusError } = await client
      .from("events")
      .update({ clip_status: "uploaded", thumbnail_path: thumbUpload.path })
      .eq("id", eventId);
    if (statusError) throw new Error(`event status update: ${statusError.message}`);
    this.deps.db.updateEventClipStatus(eventId, "uploaded", thumbUpload.path);
  }

  /**
   * Persist an event locally and, when the cloud link is up, insert it into
   * the cloud events table. Kept for ad-hoc events outside the motion flow.
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
}
