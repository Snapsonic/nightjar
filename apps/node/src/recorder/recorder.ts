import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CameraConfig } from "@nightjar/shared";
import type { ConfigStore } from "../config/store.js";
import type { NodeDb, SegmentRow } from "../db.js";
import type { Logger } from "../log.js";

const execFileAsync = promisify(execFile);

export interface ExportResult {
  /** Absolute path of the exported mp4. */
  path: string;
}

const SEGMENT_SECONDS = 60;
const POLL_MS = 2_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
/** A capture that survives this long resets the restart backoff. */
const STABLE_MS = 30_000;
const PRUNE_INTERVAL_MS = 10 * 60_000;
const KILL_GRACE_MS = 3_000;

interface CameraRecording {
  camera: CameraConfig;
  proc: ChildProcess | null;
  stopping: boolean;
  backoffMs: number;
  restartTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  spawnedAt: number;
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

  constructor(
    private readonly db: NodeDb,
    private readonly store: ConfigStore,
    private readonly log: Logger,
  ) {
    this.unsubscribe = this.store.onChange(() => this.sync());
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
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
      } else if (camera.rtspUrl !== rec.camera.rtspUrl) {
        this.log.info(`camera ${cameraId} URL changed — restarting capture`);
        this.stop(cameraId);
        this.start(camera);
      } else {
        rec.camera = camera;
      }
    }
    for (const camera of wanted.values()) {
      if (!this.recordings.has(camera.id)) this.start(camera);
    }
  }

  start(camera: CameraConfig): void {
    if (this.stopped || this.recordings.has(camera.id)) return;
    const rec: CameraRecording = {
      camera,
      proc: null,
      stopping: false,
      backoffMs: BACKOFF_START_MS,
      restartTimer: null,
      pollTimer: null,
      spawnedAt: 0,
      indexed: new Set(this.db.segmentPaths(camera.id)),
      open: new Map(),
      stderrTail: "",
    };
    this.recordings.set(camera.id, rec);
    this.reconcileDangling(camera.id);
    this.spawn(rec);
    rec.pollTimer = setInterval(() => this.pollSegments(rec), POLL_MS);
    rec.pollTimer.unref();
    this.log.info(`recording started for camera ${camera.id} ("${camera.name}")`);
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

  stopAll(): void {
    this.stopped = true;
    this.unsubscribe();
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    for (const cameraId of [...this.recordings.keys()]) this.stop(cameraId);
  }

  isRecording(cameraId: string): boolean {
    return this.recordings.get(cameraId)?.proc != null;
  }

  /* ---------- capture ---------- */

  private cameraDir(cameraId: string): string {
    return path.join(this.store.get().paths.recordings, cameraId);
  }

  private spawn(rec: CameraRecording): void {
    if (rec.stopping || this.stopped) return;
    const dir = this.cameraDir(rec.camera.id);
    // ffmpeg's segment muxer does not create directories — pre-create today's.
    mkdirSync(path.join(dir, dayName(new Date())), { recursive: true });

    // prettier-ignore
    const args = [
      "-nostdin",
      "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", rec.camera.rtspUrl,
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
      this.pollSegments(rec); // index anything the dying process flushed
      this.closeOpenSegments(rec, Date.now());
      if (rec.stopping || this.stopped) return;
      if (Date.now() - rec.spawnedAt > STABLE_MS) rec.backoffMs = BACKOFF_START_MS;
      const tail = rec.stderrTail.trim().split("\n").pop() ?? "";
      this.log.warn(
        `ffmpeg for camera ${rec.camera.id} exited (code=${code} signal=${signal})` +
          `${tail ? ` — ${tail}` : ""} — restarting in ${Math.round(rec.backoffMs / 1000)}s`,
      );
      rec.restartTimer = setTimeout(() => {
        rec.restartTimer = null;
        this.spawn(rec);
      }, rec.backoffMs);
      rec.restartTimer.unref();
      rec.backoffMs = Math.min(rec.backoffMs * 2, BACKOFF_CAP_MS);
    });
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
    const cutoffMs = Date.now() - retention.maxDays * 86_400_000;
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
      } catch {
        break;
      }
      if (usedFraction <= retention.diskHighWatermark) break;
      const oldest = this.db.segmentsStartedBefore(Number.MAX_SAFE_INTEGER, 1)[0];
      if (!oldest) break;
      this.deleteSegmentRow(oldest);
      removed++;
    }
    if (removed > 0) this.log.info(`retention pruned ${removed} segment(s)`);
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

function dayName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
