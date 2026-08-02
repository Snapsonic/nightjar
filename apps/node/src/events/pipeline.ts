import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
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
import { boxIou, SceneryModel } from "./scenery.js";

const execFileAsync = promisify(execFile);

/** Clip padding around the motion episode. */
const PRE_ROLL_MS = 5_000;
const POST_ROLL_MS = 5_000;
/** go2rtc snapshot fetch budget — on timeout the event simply stays "motion". */
const SNAPSHOT_TIMEOUT_MS = 2_000;
/**
 * How far back fetchSnapshot will reach for an on-disk frame.
 *
 * Bounded deliberately: the recorder writes continuously, so on a healthy
 * camera the newest frame is seconds old and this never binds. It only matters
 * when capture is down, and classifying a live event against footage from two
 * minutes ago would be worse than not classifying it — so give up and let the
 * go2rtc fallback try for something live.
 */
const SNAPSHOT_MAX_AGE_MS = 30_000;
/** Detections below this score are discarded by the pipeline. */
const MIN_DETECTION_SCORE = 0.5;
/**
 * Floor for animal kinds, which is lower because they are smaller.
 *
 * A cat crossing the back deck lands 40-60px tall in a 1080p frame and scores
 * 0.36-0.65 — measured over 790 frames of real footage, where 42 animal
 * detections spanned that range and only 18 cleared 0.5. The general floor is
 * tuned for subjects that fill much more of the frame, and applying it to a
 * distant cat threw away more than half the evidence that the cat was there.
 *
 * 0.4 rather than the 0.35 the worker already enforces: it keeps 36 of those
 * 42 while leaving some margin above the noise. A weak animal cannot hijack
 * somebody else's event either way, since pickKind only lets detections above
 * KIND_CREDIBLE pull rank.
 */
const MIN_ANIMAL_DETECTION_SCORE = 0.4;
const ANIMAL_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["cat", "dog", "animal"]);
/** Per-kind score floor for pipeline-level filtering. */
function minScoreFor(kind: EventKind): number {
  return ANIMAL_KINDS.has(kind) ? MIN_ANIMAL_DETECTION_SCORE : MIN_DETECTION_SCORE;
}
/** One extra detection pass this long after motionStart (if still open). */
const REDETECT_DELAY_MS = 10_000;
/**
 * How often every recording camera is detected on regardless of motion.
 *
 * Motion is a change detector on a 320x180 frame with a 1.5% trigger — about a
 * 30x30 block. A cat on the back deck covers 0.3-1.0% of that frame, so it can
 * never move enough pixels and no event ever opens: on 2026-07-31 one wandered
 * around for three separate visits, 16 minutes of footage in total, and
 * produced not a single event. Nothing downstream could help, because nothing
 * downstream ran. Small and slow subjects are structurally invisible to frame
 * differencing, and no threshold tuning changes that — only looking anyway
 * does.
 *
 * 30s gives roughly ten chances across a visit of that length, at a cost of one
 * frame read plus ~72ms of inference per recording camera.
 */
const SWEEP_INTERVAL_MS = 30_000;
/**
 * After the sweep opens an event for a camera, it stays quiet this long.
 *
 * An animal that settles in stays detected for minutes on end, and without
 * this every sweep would open another event for the same cat on the same deck.
 */
const SWEEP_COOLDOWN_MS = 5 * 60_000;
/** Footage either side of a sweep detection, which is an instant, not a span. */
const SWEEP_EVENT_PAD_MS = 5_000;
/**
 * How much an animal must move before it counts as news again.
 *
 * The cooldown alone only rate-limits: a cat asleep on the windowsill still
 * produced an event every five minutes for as long as it stayed there — 91 of
 * 96 cat events in one day came from one resident cat on one indoor-facing
 * camera, every single detection correct and none of them worth an alert.
 * "Still there" is not the same news as "arrived", so a subject whose box has
 * not moved since the last sweep event does not open another one.
 */
const SWEEP_STILL_IOU = 0.5;
/**
 * Stop tracking a subject once nothing animal-shaped has been seen this long.
 *
 * After that a detection is a fresh arrival rather than the same animal, and
 * is allowed to alert again even if it settles in the same favourite spot.
 */
const SWEEP_ABSENT_MS = 10 * 60_000;
/** Event kind priority — higher wins, but only from close enough behind (see pickKind). */
const KIND_PRIORITY: Record<EventKind, number> = {
  person: 5,
  bear: 4,
  package: 3,
  vehicle: 2,
  // Pets rank above generic "animal" (they are the identification the user
  // actually wants) but below everything else: a frame containing both the dog
  // and a delivery should be reported as the delivery.
  dog: 1.5,
  cat: 1.5,
  animal: 1,
  motion: 0,
};
/**
 * Score a detection needs before it may pull rank on something that scored
 * higher. Detections between MIN_DETECTION_SCORE and this are real enough to
 * record but too weak to relabel the whole event.
 *
 * Deliberately close to the floor. A rule that instead asked a high-priority
 * kind to stay within some margin of the best detection read well in the
 * abstract and was wrong in practice: a person at 58% standing beside a van at
 * 72% got demoted to a vehicle event. On a security camera a missed person
 * costs more than a spurious one, so the bar for demoting person is set at
 * "barely above the floor", not "close to the winner".
 */
const KIND_CREDIBLE = 0.55;

/**
 * Decide an event's kind and score from everything detected so far.
 *
 * Priority alone used to decide this, "regardless of score", which let any
 * person detection outrank any animal one. A 51% person on a terracotta
 * chiminea beat a correctly identified 63% cat, and the alert read "Person
 * detected" — the model had actually got the cat right. The score made it
 * worse: it was the maximum across every detection whatever its kind, so that
 * alert reported the cat's 63% as its confidence in a person nobody had seen.
 *
 * So priority now only ranks detections that are credible on their own, and
 * the score reported always belongs to the kind that won.
 */
export function pickKind(detections: Detection[]): { kind: EventKind; score: number } | null {
  if (detections.length === 0) return null;
  // Fall back to everything when nothing clears the bar, so a lone weak
  // detection still names its event rather than silently becoming motion.
  const credible = detections.filter((d) => d.score >= KIND_CREDIBLE);
  const pool = credible.length > 0 ? credible : detections;
  const winner = pool.reduce((a, b) => (KIND_PRIORITY[b.kind] > KIND_PRIORITY[a.kind] ? b : a));
  const score = Math.max(...detections.filter((d) => d.kind === winner.kind).map((d) => d.score));
  return { kind: winner.kind, score };
}
/** Extra wait before cutting so the post-roll footage exists on disk. */
const CLOSE_SLACK_MS = 2_000;
/** Bounded offline queue — oldest jobs beyond this are dropped. */
const MAX_QUEUED_UPLOADS = 500;
const UPLOAD_IDLE_MS = 10_000;
const UPLOAD_BACKOFF_BASE_MS = 5_000;
const UPLOAD_BACKOFF_CAP_MS = 300_000;
/** Serial queue: a permanently failing job must not block everything behind it. */
const UPLOAD_MAX_ATTEMPTS = 50;
// Cloud clip retention is NOT the node's business any more. event_clips.
// expires_at is derived server-side from the owner's plan by the
// event_clips_set_expiry trigger (migration 0014_storage_gc), which
// overwrites anything a client sends — and the node no longer holds an
// INSERT/UPDATE grant on that column. Sending it would only fail the upsert.

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
 * (YOLOX-s), which may upgrade kind/score; a second pass runs 10s in if
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
  private sweepTimer: NodeJS.Timeout | null = null;
  /** Camera -> when the sweep last opened an event, for SWEEP_COOLDOWN_MS. */
  private readonly lastSweepMs = new Map<string, number>();
  /**
   * Camera -> the subject the sweep is currently watching: where it was when it
   * last alerted, and when it was last seen at all. Lets a settled animal stay
   * one event instead of becoming one every cooldown.
   */
  private readonly sweepSubject = new Map<
    string,
    { boxes: readonly (readonly number[])[]; lastSeenMs: number }
  >();
  /** Static false positives learned from the sweep (chiminea, hedge). */
  private readonly scenery = new SceneryModel();

  constructor(private readonly deps: EventPipelineDeps) {}

  attach(detector: MotionDetector): void {
    this.unsubscribe = detector.onMotion((event) => this.onMotion(event));
    this.uploaderLoop = this.runUploader().catch((err) => {
      this.deps.log.error(`uploader crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.sweepTimer = setInterval(() => {
      void this.runSweep().catch((err) => {
        this.deps.log.warn(
          `detection sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  stop(): void {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
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

  /* ---------- motion-independent sweep ---------- */

  /**
   * Look for animals on every recording camera, whether or not anything moved.
   *
   * Deliberately animals only. The sweep sees whatever is in frame, including
   * things that are always in frame, so raising events for every kind would
   * mean an event per interval for a permanently parked van — and on the
   * Backyard camera, where a hedge scores as a person at 0.86, a person event
   * every 30 seconds for ever. Motion already catches subjects large enough to
   * trip it, which is essentially all vehicles and people; what it structurally
   * cannot catch is the small distant animal, so that is what this adds.
   *
   * Cameras with record=false are skipped: their frames are not on disk, and
   * falling back to go2rtc on a timer would rebuild the dependency that starved
   * detection in the first place.
   */
  private async runSweep(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    for (const camera of this.deps.store.get().cameras) {
      if (!camera.enabled || !camera.record) continue;
      // Motion already owns this camera right now, and runDetect is running
      // against the same frames — a sweep event would just duplicate it.
      if (this.open.has(camera.id)) continue;
      const last = this.lastSweepMs.get(camera.id) ?? 0;
      if (now - last < SWEEP_COOLDOWN_MS) continue;

      const jpeg = await this.deps.recorder.latestFrame(camera.id, SNAPSHOT_MAX_AGE_MS);
      if (!jpeg) continue; // capture is down; nothing to look at
      const zones = camera.zones ?? [];
      const all = await this.deps.detect.detect(jpeg);
      // Feed the scenery model everything, not just what the sweep acts on:
      // an object only proves it is furniture by turning up in passes nobody
      // cared about. This is the sweep's other job, and the reason the model
      // gets a clean 30s heartbeat instead of only seeing motion events.
      this.scenery.observe(camera.id, all, now);
      const found = all
        .filter((d) => ANIMAL_KINDS.has(d.kind) && d.score >= minScoreFor(d.kind))
        .filter((d) => detectionInZones(d, zones));
      if (found.length === 0) continue;

      const picked = pickKind(found);
      if (!picked) continue;

      // Same animal, same place, still there — not news. Only refresh how
      // recently it was seen, so it keeps holding its slot without alerting.
      const boxes = found.flatMap((d) => (d.box ? [d.box as readonly number[]] : []));
      const subject = this.sweepSubject.get(camera.id);
      const settled =
        subject !== undefined &&
        now - subject.lastSeenMs < SWEEP_ABSENT_MS &&
        boxes.length > 0 &&
        boxes.every((b) => subject.boxes.some((prev) => boxIou(prev, b) >= SWEEP_STILL_IOU));
      if (settled) {
        subject.lastSeenMs = now;
        continue;
      }
      this.sweepSubject.set(camera.id, { boxes, lastSeenMs: now });
      this.lastSweepMs.set(camera.id, now);
      const candidate: OpenEvent = {
        id: randomUUID(),
        cameraId: camera.id,
        kind: picked.kind,
        score: picked.score,
        startedAtMs: now - SWEEP_EVENT_PAD_MS,
        endedAtMs: now + SWEEP_EVENT_PAD_MS,
        // No motion triggered this, so there is no changed fraction to report.
        changedFraction: 0,
        detections: found,
        zoneIds: new Set(found.flatMap((d) => (d.box ? zoneIdsForBox(d.box, zones) : []))),
        closeTimer: null,
        redetectTimer: null,
      };
      this.open.set(camera.id, candidate);
      this.deps.log.info(
        `sweep found ${found
          .map((d) => `${d.kind} ${(d.score * 100).toFixed(0)}%`)
          .join(", ")} on camera ${camera.id} with no motion trigger — ` +
          `event ${candidate.id} kind ${picked.kind} ${(picked.score * 100).toFixed(0)}%`,
      );
      candidate.closeTimer = setTimeout(() => {
        this.open.delete(camera.id);
        void this.close(candidate).catch((err) => {
          this.deps.log.error(
            `event ${candidate.id} close failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, SWEEP_EVENT_PAD_MS + CLOSE_SLACK_MS);
      candidate.closeTimer.unref();
    }
  }

  /**
   * Full-color JPEG for detection — the 320x180 grayscale motion frames are
   * unusable for object detection. Returns null on any failure (the event then
   * simply stays "motion").
   *
   * Read from the recorder's own segments first, and only ask go2rtc if that
   * comes up empty. Asking go2rtc first is what this used to do, and it made
   * detection depend on the one component that keeps breaking: when a Nest
   * stream churns, go2rtc's producer goes cold and /api/frame.jpeg has to
   * re-establish it, which measured at 3.5-4.5s against the 2s budget below.
   * Every one of those timed out, so the event never got classified at all —
   * for more than a day this node was recording fine while logging 20-70
   * snapshot timeouts an hour and classifying almost nothing.
   *
   * The frames were on disk the whole time. Recorder.latestFrame reads the
   * newest one already written, which costs no network call and cannot stall
   * on a cold producer — the same reasoning that moved dashboard snapshots off
   * that endpoint. go2rtc remains the fallback for cameras the recorder does
   * not cover (record=false) or whose capture is currently down.
   */
  private async fetchSnapshot(cameraId: string): Promise<Buffer | null> {
    try {
      const frame = await this.deps.recorder.latestFrame(cameraId, SNAPSHOT_MAX_AGE_MS);
      if (frame) return frame;
    } catch (err) {
      this.deps.log.warn(
        `detect snapshot for camera ${cameraId} from segments failed: ${err instanceof Error ? err.message : String(err)} — trying go2rtc`,
      );
    }
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
      const now = Date.now();
      const raw = await this.deps.detect.detect(jpeg);
      // Drop the furniture first: objects the sweep has watched sit perfectly
      // still for half an hour are not people, whatever the model scores them.
      const live = raw.filter((d) => !this.scenery.isScenery(candidate.cameraId, d, now));
      const furniture = raw.length - live.length;
      if (furniture > 0) {
        this.deps.log.info(
          `event ${candidate.id}: ${furniture} detection(s) ignored as scenery — ` +
            `${this.scenery.describe(candidate.cameraId, now).join("; ")}`,
        );
      }
      const scored = live.filter((d) => d.score >= minScoreFor(d.kind));
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
      // Recomputed over every detection so far, not folded in one at a time:
      // the second pass can only be judged against the first if both are on
      // the table at once.
      const picked = pickKind(candidate.detections);
      if (picked) {
        candidate.kind = picked.kind;
        candidate.score = picked.score;
      }
      this.deps.log.info(
        `event ${candidate.id}: detected ${detections
          .map((d) => `${d.kind} ${(d.score * 100).toFixed(0)}%`)
          .join(", ")} — kind ${candidate.kind} ${(candidate.score * 100).toFixed(0)}%`,
      );
    } catch (err) {
      this.deps.log.warn(`detect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * delogo filter for a camera's watermark box, sized against the clip's real
   * dimensions. Returns null when the camera has no box or the probe fails —
   * a missing filter is always better than a failed export.
   */
  private async buildDelogoFilter(cameraId: string, clipPath: string): Promise<string | null> {
    const box = this.deps.store.get().cameras.find((c) => c.id === cameraId)?.hideWatermark;
    if (!box) return null;
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "csv=p=0", clipPath],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
      );
      const [w, h] = stdout.trim().split(",").map(Number);
      if (!w || !h) return null;
      // delogo needs integers and at least a 1px margin inside the frame.
      const x = Math.max(1, Math.round(box.x * w));
      const y = Math.max(1, Math.round(box.y * h));
      const bw = Math.max(2, Math.min(Math.round(box.w * w), w - x - 1));
      const bh = Math.max(2, Math.min(Math.round(box.h * h), h - y - 1));
      return `delogo=x=${x}:y=${y}:w=${bw}:h=${bh}`;
    } catch {
      return null;
    }
  }

  /**
   * Re-encode the clip with the watermark blanked. Only shared artefacts pay
   * this cost; if anything fails the original clip is kept as-is.
   */
  private async stripWatermark(cameraId: string, clipPath: string): Promise<void> {
    const filter = await this.buildDelogoFilter(cameraId, clipPath);
    if (!filter) return;
    const tmp = `${clipPath}.clean.mp4`;
    try {
      // prettier-ignore
      await execFileAsync(
        "ffmpeg",
        [
          "-nostdin", "-loglevel", "error", "-y",
          "-i", clipPath,
          "-vf", filter,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-c:a", "copy", "-movflags", "+faststart",
          tmp,
        ],
        { timeout: 180_000, maxBuffer: 1024 * 1024 },
      );
      renameSync(tmp, clipPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      this.deps.log.warn(
        `watermark strip failed for camera ${cameraId} — keeping the original clip: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
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
      await this.stripWatermark(candidate.cameraId, clipPath);
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
      // The whole iteration (nextUpload included) is guarded: an unexpected
      // throw must never end this loop while the pipeline is running.
      try {
        await this.uploaderIteration();
      } catch (err) {
        this.deps.log.error(
          `uploader iteration failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.sleep(UPLOAD_IDLE_MS);
      }
    }
  }

  private async uploaderIteration(): Promise<void> {
    const job = this.deps.db.nextUpload();
    if (!job) {
      await this.sleep(UPLOAD_IDLE_MS);
      return;
    }
    if (!this.deps.link.getClient()) {
      // Cloud unlinked/offline — leave the job queued and check again later.
      await this.sleep(UPLOAD_IDLE_MS);
      return;
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
      // never succeed blocks every event behind it forever. Missing clip
      // files are unrecoverable — abandon immediately instead of retrying.
      const unrecoverable = (err as NodeJS.ErrnoException).code === "ENOENT";
      if (unrecoverable || job.attempts + 1 >= UPLOAD_MAX_ATTEMPTS) {
        this.deps.log.error(
          `upload of event ${job.event_id} abandoned after ${job.attempts + 1} attempts: ` +
            `${err instanceof Error ? err.message : String(err)} — clip stays local`,
        );
        this.deps.db.updateEventClipStatus(job.event_id, "local");
        this.deps.db.deleteUpload(job.id);
        if (!this.deps.db.clipReferenced(job.event_id)) {
          rmSync(job.file, { recursive: true, force: true });
        }
        return;
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
    // drive_url is only included when this node has already captured one for
    // the event (Drive backup with share links finished first). Omitting the
    // key on conflict leaves any value the Drive queue wrote later intact —
    // PostgREST upserts only SET the columns present in the payload.
    const driveUrl = this.deps.db.getEventDriveUrl(eventId);
    const { error: clipRowError } = await client.from("event_clips").upsert(
      {
        event_id: eventId,
        storage_path: clipUpload.path,
        bytes: clipBytes,
        duration_s: durationS,
        ...(driveUrl ? { drive_url: driveUrl } : {}),
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
   * Publish a clip's Google Drive share URL to the cloud so the notify
   * function can point alerts at it. Called by GdriveBackup when its upload
   * finishes AFTER this pipeline already created the event_clips row; when it
   * finishes first the row does not exist yet, the update matches nothing, and
   * uploadEvent folds the URL in from SQLite instead.
   */
  async publishDriveUrl(eventId: string, driveUrl: string): Promise<void> {
    const client = this.deps.link.getClient();
    if (!client) return; // offline — uploadEvent will carry it when it runs
    const { error } = await client
      .from("event_clips")
      .update({ drive_url: driveUrl })
      .eq("event_id", eventId);
    if (error) throw new Error(`event_clips drive_url update: ${error.message}`);
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
