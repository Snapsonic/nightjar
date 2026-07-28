import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CameraConfig } from "@nightjar/shared";
import { jitterMs, SPAWN_STAGGER_MS, StreamBreaker, StreamStartGate } from "../backoff.js";
import { captureMainUrl } from "../cameras/streams.js";
import type { ConfigStore } from "../config/store.js";
import type { NodeDb, SegmentRow } from "../db.js";
import { rtspInputArgs } from "../ffmpeg.js";
import type { Logger } from "../log.js";

const execFileAsync = promisify(execFile);

export interface ExportResult {
  /** Absolute path of the exported mp4. */
  path: string;
}

const SEGMENT_SECONDS = 60;
const POLL_MS = 2_000;
const BACKOFF_START_MS = 1_000;
// Patient cap: every reconnect asks Google to generate a new SDM stream, and
// SDM rate-limits per minute — a tight retry herd (5 cams x 2 consumers at
// 15s) never lets the quota recover. Success still resets to 1s via STABLE_MS.
const BACKOFF_CAP_MS = 300_000;
/** A capture that survives this long resets the restart backoff. */
const STABLE_MS = 30_000;
const PRUNE_INTERVAL_MS = 10 * 60_000;
const KILL_GRACE_MS = 3_000;
/** Local event rows / dead queue jobs older than this are pruned. */
const EVENT_MAX_AGE_MS = 30 * 86_400_000;
/** Watermark pruning never touches segments newer than this. */
export const PRUNE_FLOOR_MS = 24 * 3_600_000;
/** Throttle for repeated prune-time error/warn logs. */
const PRUNE_LOG_THROTTLE_MS = 3_600_000;
/**
 * How many recent segments a snapshot may fall back through. The newest is
 * still being written, so one spare is the common case; three covers a camera
 * that just restarted mid-segment without reaching for stale footage.
 */
const SNAPSHOT_SEGMENT_CANDIDATES = 3;
/** Emergency (disk-full) prunes are rate-limited to one per this interval. */
const EMERGENCY_PRUNE_MIN_INTERVAL_MS = 30_000;

/**
 * Capture liveness threshold: a camera counts as capturing when its newest
 * indexed segment instant is within 3x the segment duration of now.
 */
export const CAPTURE_LIVENESS_MS = 3 * SEGMENT_SECONDS * 1000;

/** Pure liveness predicate — true when the newest segment is fresh enough. */
export function isCaptureLive(lastSegmentAtMs: number | null, nowMs: number): boolean {
  return lastSegmentAtMs !== null && nowMs - lastSegmentAtMs <= CAPTURE_LIVENESS_MS;
}

interface CameraRecording {
  camera: CameraConfig;
  proc: ChildProcess | null;
  stopping: boolean;
  backoffMs: number;
  restartTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  spawnedAt: number;
  /** Last time the wedge watchdog killed this capture (kill-once guard). */
  lastWedgeKillMs: number;
  /** Paths already indexed in SQLite (dedupe across polls/restarts). */
  indexed: Set<string>;
  /** Open (still being written) segments: path -> segment row id. */
  open: Map<string, number>;
  stderrTail: string;
}

/**
 * Continuous recorder. One long-lived ffmpeg per camera with record=true
 * copying the MAIN stream into 60s fragmented-mp4 segments under
 * <recordings>/<cameraId>/<YYYYMMDD>/<unix>.mp4. Segment completion is
 * detected by polling the day directory (fs.watch is unreliable on macOS):
 * a segment is complete once a newer file appears or the process exits.
 * Crashed captures restart with exponential backoff (cap 60s); a retention
 * pruner enforces retention.maxDays and retention.diskHighWatermark.
 */
export class Recorder {
  private readonly recordings = new Map<string, CameraRecording>();
  private readonly unsubscribe: () => void;
  private pruneTimer: NodeJS.Timeout | null;
  private stopped = false;
  private lastStatfsWarnMs = 0;
  private lastFloorErrorMs = 0;
  private lastEmergencyPruneMs = 0;

  constructor(
    private readonly db: NodeDb,
    private readonly store: ConfigStore,
    private readonly log: Logger,
    /** Shared with the motion detector: stream creation is a per-project
     *  quota, so the breaker has to count failures across every capture. */
    private readonly breaker: StreamBreaker = new StreamBreaker(),
    /** Shared with the motion detector — paces starts across all captures. */
    private readonly gate: StreamStartGate = new StreamStartGate(),
  ) {
    this.unsubscribe = this.store.onChange(() => this.sync());
    this.pruneTimer = setInterval(() => {
      try {
        this.prune();
      } catch (err) {
        this.log.warn(`retention prune failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  /* ---------- lifecycle ---------- */

  /** Reconcile running captures with the current config. */
  sync(): void {
    if (this.stopped) return;
    const wanted = new Map(
      this.store
        .get()
        .cameras.filter((c) => c.enabled && c.record)
        .map((c) => [c.id, c] as const),
    );
    for (const [cameraId, rec] of [...this.recordings]) {
      const camera = wanted.get(cameraId);
      if (!camera) {
        this.stop(cameraId);
      } else if (this.captureUrl(camera) !== this.captureUrl(rec.camera)) {
        this.log.info(`camera ${cameraId} URL changed — restarting capture`);
        this.stop(cameraId);
        this.start(camera);
      } else {
        rec.camera = camera;
      }
    }
    let index = 0;
    for (const camera of wanted.values()) {
      // Stagger fresh spawns by camera index so a node (re)start doesn't herd
      // every capture onto the upstream at once.
      if (!this.recordings.has(camera.id)) this.start(camera, index * SPAWN_STAGGER_MS);
      index++;
    }
  }

  start(camera: CameraConfig, delayMs = 0): void {
    if (this.stopped || this.recordings.has(camera.id)) return;
    const rec: CameraRecording = {
      camera,
      proc: null,
      stopping: false,
      backoffMs: BACKOFF_START_MS,
      restartTimer: null,
      pollTimer: null,
      spawnedAt: 0,
      lastWedgeKillMs: 0,
      indexed: new Set(this.db.segmentPaths(camera.id)),
      open: new Map(),
      stderrTail: "",
    };
    this.recordings.set(camera.id, rec);
    this.reconcileDangling(camera.id);
    if (delayMs > 0) {
      rec.restartTimer = setTimeout(() => {
        rec.restartTimer = null;
        this.spawn(rec);
      }, delayMs);
      rec.restartTimer.unref();
    } else {
      this.spawn(rec);
    }
    rec.pollTimer = setInterval(() => {
      try {
        this.pollSegments(rec);
        this.checkWedged(rec);
      } catch (err) {
        this.log.warn(
          `segment poll for camera ${camera.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, POLL_MS);
    rec.pollTimer.unref();
    this.log.info(
      `recording started for camera ${camera.id} ("${camera.name}")` +
        (delayMs > 0 ? ` — first spawn in ${Math.round(delayMs / 1000)}s` : ""),
    );
  }

  stop(cameraId: string): void {
    const rec = this.recordings.get(cameraId);
    if (!rec) return;
    this.recordings.delete(cameraId);
    rec.stopping = true;
    if (rec.restartTimer) clearTimeout(rec.restartTimer);
    if (rec.pollTimer) clearInterval(rec.pollTimer);
    this.killProcess(rec);
    this.closeOpenSegments(rec, Date.now());
    this.log.info(`recording stopped for camera ${cameraId}`);
  }

  /** Stop everything; resolves once every child has exited (or the kill-grace cap). */
  async stopAll(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    const procs = [...this.recordings.values()]
      .map((rec) => rec.proc)
      .filter((proc): proc is ChildProcess => proc !== null);
    for (const cameraId of [...this.recordings.keys()]) this.stop(cameraId);
    await Promise.all(procs.map((proc) => waitForExit(proc, KILL_GRACE_MS)));
  }

  isRecording(cameraId: string): boolean {
    return this.recordings.get(cameraId)?.proc != null;
  }

  /** Newest indexed segment instant for a camera (unix ms), from the SQLite index. */
  /**
   * Newest frame from what is already on disk, as JPEG bytes.
   *
   * Snapshots used to come from go2rtc's frame endpoint, which makes Google
   * mint an SDM stream on a cold camera — so a dashboard full of tiles was
   * itself a source of the rate-limiting that broke recording. We are already
   * writing every second of video to disk; read from that instead. Returns
   * null when there is no recent segment (e.g. record=false cameras), and the
   * caller falls back to go2rtc.
   */
  async latestFrame(cameraId: string, maxAgeMs = 120_000): Promise<Buffer | null> {
    const segments = this.db.segmentsBetween(cameraId, Date.now() - maxAgeMs, Date.now());
    // Newest first, but do not stop at the newest: the current segment is still
    // being written and a freshly opened one often has no decodable frame yet,
    // which is what produced empty snapshots. Fall back through the previous
    // segments — a frame a minute old beats no frame at all.
    for (const segment of segments.slice(-SNAPSHOT_SEGMENT_CANDIDATES).reverse()) {
      const frame = await this.extractFrame(segment.path);
      if (frame) return frame;
    }
    return null;
  }

  /** Most recent decodable frame in one segment file, or null. */
  private async extractFrame(file: string): Promise<Buffer | null> {
    try {
      const { stdout } = await execFileAsync(
        "ffmpeg",
        // -sseof seeks from the end: the most recent decodable frame.
        ["-nostdin", "-loglevel", "error", "-sseof", "-3", "-i", file,
         "-frames:v", "1", "-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
        { timeout: 15_000, maxBuffer: 12 * 1024 * 1024, encoding: "buffer" },
      );
      return stdout.length > 0 ? stdout : null;
    } catch {
      return null;
    }
  }

  /**
   * Restart one camera's capture now, resetting its backoff.
   *
   * For when something upstream has been repaired — currently a forced Nest
   * stream refresh. Repeated capture failures push the restart delay to the
   * 300s cap (up to ~450s once jitter is applied), which is right when the
   * upstream is genuinely sick and wrong the moment it is fixed: the stream
   * would be healthy while the recorder sat out a seven-minute timer. Observed
   * live as a motion event whose clip export failed with "no recorded
   * segments" — the camera was up, and we still had no footage of it.
   */
  kick(cameraId: string): void {
    const rec = this.recordings.get(cameraId);
    if (!rec || rec.stopping || this.stopped) return;
    rec.backoffMs = BACKOFF_START_MS;
    if (rec.restartTimer) {
      clearTimeout(rec.restartTimer);
      rec.restartTimer = null;
    }
    // A live capture needs nothing: it is either working or about to exit and
    // take the restart path, which now starts from the reset backoff.
    if (rec.proc) return;
    this.spawn(rec);
  }

  lastSegmentAt(cameraId: string): number | null {
    return this.db.latestSegmentAt(cameraId);
  }

  /* ---------- capture ---------- */

  private cameraDir(cameraId: string): string {
    return path.join(this.store.get().paths.recordings, cameraId);
  }

  /** Main-stream URL to record — camera RTSP, or go2rtc's restream for nest. */
  private captureUrl(camera: CameraConfig): string {
    return captureMainUrl(this.store.get(), camera);
  }

  private spawn(rec: CameraRecording): void {
    // Take a turn at the shared gate before touching the upstream. Fire and
    // forget: the gate resolves in order, and stop() clears rec.stopping so a
    // queued turn for a removed camera is dropped here.
    void this.gate.acquire().then(() => {
      if (rec.stopping || this.stopped) return;
      this.spawnNow(rec);
    });
  }

  private spawnNow(rec: CameraRecording): void {
    if (rec.stopping || this.stopped) return;
    const dir = this.cameraDir(rec.camera.id);
    // ffmpeg's segment muxer does not create directories — pre-create today's.
    mkdirSync(path.join(dir, dayName(new Date())), { recursive: true });

    // prettier-ignore
    const args = [
      ...rtspInputArgs(this.captureUrl(rec.camera)),
      "-c", "copy",
      "-map", "0",
      "-f", "segment",
      "-segment_time", String(SEGMENT_SECONDS),
      "-segment_format", "mp4",
      // flush_packets=1 keeps in-progress fragmented segments readable on
      // disk (without it the muxer buffers ~32KB and the moov never lands
      // until the segment closes, breaking exports that cover "now").
      "-segment_format_options", "movflags=+frag_keyframe+empty_moov+default_base_moof:flush_packets=1",
      "-reset_timestamps", "1",
      "-strftime", "1",
      path.join(dir, "%Y%m%d", "%s.mp4"),
    ];
    // detached => own process group so stop() can kill ffmpeg and any children.
    const proc = spawn("ffmpeg", args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    rec.proc = proc;
    rec.spawnedAt = Date.now();
    rec.stderrTail = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      rec.stderrTail = (rec.stderrTail + chunk.toString()).slice(-2000);
    });
    proc.on("error", (err) => {
      this.log.error(`ffmpeg spawn failed for camera ${rec.camera.id}: ${err.message}`);
    });
    proc.on("exit", (code, signal) => {
      if (rec.proc !== proc) return;
      rec.proc = null;
      try {
        this.pollSegments(rec); // index anything the dying process flushed
        this.closeOpenSegments(rec, Date.now());
      } catch (err) {
        this.log.warn(
          `segment sweep after ffmpeg exit for camera ${rec.camera.id} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (rec.stopping || this.stopped) return;
      const lived = Date.now() - rec.spawnedAt;
      if (lived > STABLE_MS) {
        rec.backoffMs = BACKOFF_START_MS;
        this.breaker.recordSuccess();
      } else if (this.breaker.recordFailure()) {
        this.log.error(
          "too many capture failures across cameras — pausing all captures for " +
            `${Math.round(this.breaker.waitMs() / 1000)}s so the upstream rate limit can clear`,
        );
      }
      const delayMs = Math.max(jitterMs(rec.backoffMs), this.breaker.waitMs());
      const tail = rec.stderrTail.trim().split("\n").pop() ?? "";
      this.log.warn(
        `ffmpeg for camera ${rec.camera.id} exited (code=${code} signal=${signal})` +
          `${tail ? ` — ${tail}` : ""} — restarting in ${Math.round(delayMs / 1000)}s`,
      );
      rec.restartTimer = setTimeout(() => {
        rec.restartTimer = null;
        this.spawn(rec);
      }, delayMs);
      rec.restartTimer.unref();
      rec.backoffMs = Math.min(rec.backoffMs * 2, BACKOFF_CAP_MS);
    });
  }

  /**
   * Wedge watchdog (runs on the poll interval): a live ffmpeg that has not
   * produced a segment for 3x the segment duration is stuck (e.g. frozen
   * upstream that still holds the TCP session) — kill it and let the normal
   * restart-with-backoff path take over.
   */
  private checkWedged(rec: CameraRecording): void {
    if (rec.proc === null || rec.stopping) return;
    const now = Date.now();
    if (now - rec.lastWedgeKillMs < CAPTURE_LIVENESS_MS) return; // kill in flight / just retried
    const newestMs = Math.max(this.lastSegmentAt(rec.camera.id) ?? 0, rec.spawnedAt);
    if (now - newestMs <= CAPTURE_LIVENESS_MS) return;
    rec.lastWedgeKillMs = now;
    this.log.warn(
      `capture for camera ${rec.camera.id} looks wedged — no new segments for ` +
        `${Math.round((now - newestMs) / 1000)}s, killing ffmpeg`,
    );
    this.killProcess(rec);
  }

  private killProcess(rec: CameraRecording): void {
    const proc = rec.proc;
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

  /* ---------- segment indexing ---------- */

  /** Close (or drop) rows left with ended_at NULL by a previous run. */
  private reconcileDangling(cameraId: string): void {
    for (const row of this.db.openSegments(cameraId)) {
      try {
        const stat = statSync(row.path);
        if (stat.size === 0) {
          unlinkSync(row.path);
          this.db.deleteSegment(row.id);
        } else {
          this.db.endSegment(row.id, Math.round(stat.mtimeMs));
        }
      } catch {
        this.db.deleteSegment(row.id); // file is gone
      }
    }
  }

  /** Poll the newest day dirs: index new files, complete all but the newest. */
  private pollSegments(rec: CameraRecording): void {
    const dir = this.cameraDir(rec.camera.id);
    try {
      // Keep today's dir existing so midnight rollover never fails the muxer.
      mkdirSync(path.join(dir, dayName(new Date())), { recursive: true });
    } catch {
      // recordings volume unavailable — ffmpeg will fail and restart with backoff
    }
    let files: { path: string; startedAt: number }[];
    try {
      const days = readdirSync(dir)
        .filter((name) => /^\d{8}$/.test(name))
        .sort()
        .slice(-2); // today + yesterday covers rollover
      files = days.flatMap((day) =>
        readdirSync(path.join(dir, day))
          .filter((name) => /^\d+\.mp4$/.test(name))
          .map((name) => ({
            path: path.join(dir, day, name),
            startedAt: Number(name.slice(0, -4)) * 1000,
          })),
      );
    } catch {
      return;
    }
    files.sort((a, b) => a.startedAt - b.startedAt);
    const newest = files[files.length - 1];
    for (const file of files) {
      if (!rec.indexed.has(file.path)) {
        rec.indexed.add(file.path);
        rec.open.set(file.path, this.db.insertSegment(rec.camera.id, file.path, file.startedAt));
      }
      if (newest && file.startedAt < newest.startedAt) {
        const id = rec.open.get(file.path);
        if (id !== undefined) {
          rec.open.delete(file.path);
          const next = files.find((f) => f.startedAt > file.startedAt);
          this.finishSegment(
            id,
            file.path,
            next ? next.startedAt : file.startedAt + SEGMENT_SECONDS * 1000,
          );
        }
      }
    }
  }

  private finishSegment(id: number, filePath: string, endedAtMs: number): void {
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      // treated as empty below
    }
    if (size === 0) {
      this.log.warn(`dropping empty segment ${filePath}`);
      try {
        unlinkSync(filePath);
      } catch {
        // already gone
      }
      this.db.deleteSegment(id);
      return;
    }
    this.db.endSegment(id, endedAtMs);
    this.log.debug(`segment complete: ${filePath} (${size} bytes)`);
  }

  private closeOpenSegments(rec: CameraRecording, endedAtMs: number): void {
    for (const [filePath, id] of [...rec.open]) {
      rec.open.delete(filePath);
      this.finishSegment(id, filePath, endedAtMs);
    }
  }

  /* ---------- retention ---------- */

  /** Delete expired segments, then oldest-first while over the disk watermark. */
  prune(): void {
    const retention = this.store.get().retention;
    const now = Date.now();
    // Absolute floor: nothing newer than 24h is ever pruned, even when the
    // watermark cannot be satisfied.
    const floorMs = now - PRUNE_FLOOR_MS;
    const cutoffMs = Math.min(now - retention.maxDays * 86_400_000, floorMs);
    let removed = 0;
    for (const row of this.db.segmentsStartedBefore(cutoffMs, 5_000)) {
      this.deleteSegmentRow(row);
      removed++;
    }
    const recordingsDir = this.store.get().paths.recordings;
    for (let i = 0; i < 500; i++) {
      let usedFraction: number;
      try {
        const stats = statfsSync(recordingsDir);
        usedFraction = stats.blocks > 0 ? (stats.blocks - stats.bavail) / stats.blocks : 0;
      } catch (err) {
        if (now - this.lastStatfsWarnMs >= PRUNE_LOG_THROTTLE_MS) {
          this.lastStatfsWarnMs = now;
          this.log.warn(
            `statfs failed for ${recordingsDir} — skipping watermark prune: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      }
      if (usedFraction <= retention.diskHighWatermark) break;
      const oldest = this.db.segmentsStartedBefore(floorMs, 1)[0];
      if (!oldest) {
        if (now - this.lastFloorErrorMs >= PRUNE_LOG_THROTTLE_MS) {
          this.lastFloorErrorMs = now;
          this.log.error(
            `disk is over the high watermark (${Math.round(usedFraction * 100)}%) but every ` +
              `remaining segment is under the 24h prune floor — cannot free more space`,
          );
        }
        break;
      }
      this.deleteSegmentRow(oldest);
      removed++;
    }
    if (removed > 0) this.log.info(`retention pruned ${removed} segment(s)`);
    this.pruneLocalRows(now);
  }

  /** Drop 30-day-old local event rows and dead upload/backup queue leftovers. */
  private pruneLocalRows(nowMs: number): void {
    const dropped = this.db.pruneOldRows(nowMs - EVENT_MAX_AGE_MS);
    for (const row of [...dropped.uploads, ...dropped.gdrive]) {
      if (!this.db.clipReferenced(row.event_id)) {
        rmSync(row.file, { recursive: true, force: true });
      }
    }
    const queued = dropped.uploads.length + dropped.gdrive.length;
    if (dropped.events > 0 || queued > 0) {
      this.log.info(
        `pruned ${dropped.events} local event row(s) and ${queued} stale queue job(s) (>30d)`,
      );
    }
  }

  /**
   * Disk-full escape hatch (wired to NodeDb's SQLITE_FULL handler): delete the
   * oldest segments beyond the 24h floor right now so writes can proceed.
   * Rate-limited so repeated failing writes cannot loop it.
   */
  emergencyPrune(): void {
    const now = Date.now();
    if (now - this.lastEmergencyPruneMs < EMERGENCY_PRUNE_MIN_INTERVAL_MS) return;
    this.lastEmergencyPruneMs = now;
    const rows = this.db.segmentsStartedBefore(now - PRUNE_FLOOR_MS, 50);
    if (rows.length === 0) {
      this.log.error(
        "disk full but every remaining segment is under the 24h prune floor — cannot free space",
      );
      return;
    }
    for (const row of rows) this.deleteSegmentRow(row);
    this.log.warn(`emergency prune (disk full) removed ${rows.length} oldest segment(s)`);
  }

  private deleteSegmentRow(row: SegmentRow): void {
    try {
      unlinkSync(row.path);
    } catch {
      // file already gone
    }
    this.db.deleteSegment(row.id);
    this.recordings.get(row.camera_id)?.indexed.delete(row.path);
    try {
      rmdirSync(path.dirname(row.path)); // drop the day dir once empty
    } catch {
      // not empty — fine
    }
  }

  /* ---------- playback / export ---------- */

  /** Segments overlapping [t0Ms, t1Ms) — served from the SQLite index. */
  segmentsBetween(cameraId: string, t0Ms: number, t1Ms: number): SegmentRow[] {
    return this.db.segmentsBetween(cameraId, t0Ms, t1Ms);
  }

  /**
   * Export a continuous clip covering [t0Ms, t1Ms) to outPath (caller deletes).
   * Concat demuxer over the covering segments with stream copy; the leading
   * offset is trimmed with an input-side -ss (keyframe-aligned). Handles the
   * one-segment case naturally; throws when no segments cover the range.
   */
  async exportRange(
    cameraId: string,
    t0Ms: number,
    t1Ms: number,
    outPath: string,
  ): Promise<ExportResult> {
    // Skip files below 1KB: a just-opened segment holds only its ftyp box
    // for an instant and cannot be demuxed yet.
    const rows = this.db.segmentsBetween(cameraId, t0Ms, t1Ms).filter((row) => {
      try {
        return statSync(row.path).size > 1024;
      } catch {
        return false;
      }
    });
    const first = rows[0];
    if (!first) throw new Error(`no recorded segments for camera ${cameraId} in range`);

    const effStartMs = Math.max(t0Ms, first.started_at);
    const offsetS = (effStartMs - first.started_at) / 1000;
    const durationS = (t1Ms - effStartMs) / 1000;
    if (durationS <= 0) throw new Error("empty export range");

    mkdirSync(path.dirname(outPath), { recursive: true });
    const listPath = `${outPath}.list.txt`;
    writeFileSync(
      listPath,
      rows.map((row) => `file '${row.path.replaceAll("'", "'\\''")}'`).join("\n") + "\n",
      "utf8",
    );
    try {
      // prettier-ignore
      await execFileAsync(
        "ffmpeg",
        [
          "-nostdin", "-loglevel", "error", "-y",
          "-f", "concat", "-safe", "0",
          ...(offsetS > 0 ? ["-ss", offsetS.toFixed(3)] : []),
          "-i", listPath,
          "-t", durationS.toFixed(3),
          "-c", "copy",
          "-movflags", "+faststart",
          outPath,
        ],
        { timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
    } catch (err) {
      throw new Error(`export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      try {
        unlinkSync(listPath);
      } catch {
        // best effort
      }
    }
    return { path: outPath };
  }
}

/** Resolve when the child has exited, or after capMs (whichever is first). */
function waitForExit(proc: ChildProcess, capMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const cap = setTimeout(resolve, capMs);
    cap.unref();
    proc.once("exit", () => {
      clearTimeout(cap);
      resolve();
    });
  });
}

function dayName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
