import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { NvrEvent } from "@nightjar/shared";

export interface SegmentRow {
  id: number;
  camera_id: string;
  path: string;
  started_at: number; // unix ms
  ended_at: number | null; // unix ms, null while segment is being written
}

export interface UploadQueueRow {
  id: number;
  event_id: string;
  file: string;
  attempts: number;
  created_at: number;
}

export interface GdriveQueueRow {
  id: number;
  event_id: string;
  file: string;
  attempts: number;
  created_at: number;
}

export interface EventRow {
  id: string;
  camera_id: string;
  kind: string;
  score: number;
  started_at: string;
  ended_at: string | null;
  clip_status: string;
  thumbnail_path: string | null;
  metadata: string;
}

/**
 * Local SQLite state at ${DB_DIR}/nightjar.db (default /db).
 * Holds the recording segment index, a local mirror of events, and the
 * clip upload queue. Migration-on-open via PRAGMA user_version.
 */
export class NodeDb {
  readonly db: Database.Database;
  private onDiskFull: (() => void) | null = null;

  constructor(dbDir: string = process.env.DB_DIR ?? "/db") {
    mkdirSync(dbDir, { recursive: true });
    this.db = new Database(path.join(dbDir, "nightjar.db"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  /** Called when a write fails with SQLITE_FULL — wired to the recorder's emergency prune. */
  setDiskFullHandler(handler: () => void): void {
    this.onDiskFull = handler;
  }

  /**
   * Run a write; on SQLITE_FULL trigger the emergency prune (frees recording
   * segments) and retry once, so a full disk degrades instead of throwing on
   * every poll.
   */
  private write<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_FULL" && this.onDiskFull) {
        this.onDiskFull();
        return fn();
      }
      throw err;
    }
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS segments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          camera_id TEXT NOT NULL,
          path TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_segments_camera_time
          ON segments (camera_id, started_at);

        -- Local mirror of the cloud events table (source of truth for local playback).
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          camera_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          score REAL NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          clip_status TEXT NOT NULL DEFAULT 'local',
          thumbnail_path TEXT,
          metadata TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_events_camera_time
          ON events (camera_id, started_at);

        CREATE TABLE IF NOT EXISTS upload_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL,
          file TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `);
      this.db.pragma("user_version = 1");
    }
    if (version < 2) {
      this.db.exec(`
        -- Serial Google Drive backup queue — mirrors upload_queue semantics.
        -- An event's clip dir may sit in both queues; it is deleted only when
        -- neither queue references the event any more (see clipReferenced).
        CREATE TABLE IF NOT EXISTS gdrive_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL,
          file TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        -- Drive folder-id cache; cache_key is "<parentId>/<name>".
        CREATE TABLE IF NOT EXISTS gdrive_folders (
          cache_key TEXT PRIMARY KEY,
          folder_id TEXT NOT NULL
        );
      `);
      this.db.pragma("user_version = 2");
    }
    if (version < 3) {
      // Anyone-with-the-link Drive URL for the backed-up clip, captured by
      // the gdrive uploader. Kept locally as well as pushed to the cloud so
      // the two queues can finish in either order: whichever runs last fills
      // event_clips.drive_url in (see EventPipeline.uploadEvent).
      this.db.exec(`ALTER TABLE events ADD COLUMN drive_url TEXT;`);
      this.db.pragma("user_version = 3");
    }
  }

  /** Remember the Drive share URL captured for an event's clip. */
  setEventDriveUrl(eventId: string, driveUrl: string): void {
    this.write(() =>
      this.db.prepare("UPDATE events SET drive_url = ? WHERE id = ?").run(driveUrl, eventId),
    );
  }

  getEventDriveUrl(eventId: string): string | null {
    const row = this.db.prepare("SELECT drive_url FROM events WHERE id = ?").get(eventId) as
      | { drive_url: string | null }
      | undefined;
    return row?.drive_url ?? null;
  }

  insertSegment(cameraId: string, filePath: string, startedAtMs: number): number {
    const result = this.write(() =>
      this.db
        .prepare("INSERT INTO segments (camera_id, path, started_at) VALUES (?, ?, ?)")
        .run(cameraId, filePath, startedAtMs),
    );
    return Number(result.lastInsertRowid);
  }

  endSegment(id: number, endedAtMs: number): void {
    this.write(() => this.db.prepare("UPDATE segments SET ended_at = ? WHERE id = ?").run(endedAtMs, id));
  }

  deleteSegment(id: number): void {
    this.write(() => this.db.prepare("DELETE FROM segments WHERE id = ?").run(id));
  }

  /** Newest indexed segment instant (ended_at, or started_at while open) for one camera. */
  latestSegmentAt(cameraId: string): number | null {
    const row = this.db
      .prepare(
        "SELECT MAX(COALESCE(ended_at, started_at)) AS at FROM segments WHERE camera_id = ?",
      )
      .get(cameraId) as { at: number | null };
    return row.at;
  }

  /** Rows still marked in-progress (ended_at NULL) for one camera — dangling after a crash. */
  openSegments(cameraId: string): SegmentRow[] {
    return this.db
      .prepare(
        `SELECT id, camera_id, path, started_at, ended_at FROM segments
         WHERE camera_id = ? AND ended_at IS NULL ORDER BY started_at ASC`,
      )
      .all(cameraId) as SegmentRow[];
  }

  /** All indexed segment paths for one camera (dedupe on recorder restart). */
  segmentPaths(cameraId: string): string[] {
    return (
      this.db.prepare("SELECT path FROM segments WHERE camera_id = ?").all(cameraId) as {
        path: string;
      }[]
    ).map((row) => row.path);
  }

  /** Completed segments that started before cutoffMs, oldest first. */
  segmentsStartedBefore(cutoffMs: number, limit: number): SegmentRow[] {
    return this.db
      .prepare(
        `SELECT id, camera_id, path, started_at, ended_at FROM segments
         WHERE started_at < ? AND ended_at IS NOT NULL
         ORDER BY started_at ASC LIMIT ?`,
      )
      .all(cutoffMs, limit) as SegmentRow[];
  }

  /** Distinct node-local days (YYYY-MM-DD) with any segments for one camera, ascending. */
  segmentDays(cameraId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') AS day
           FROM segments WHERE camera_id = ? ORDER BY day ASC`,
        )
        .all(cameraId) as { day: string }[]
    ).map((row) => row.day);
  }

  /** Segments overlapping [t0Ms, t1Ms) for one camera, oldest first. */
  segmentsBetween(cameraId: string, t0Ms: number, t1Ms: number): SegmentRow[] {
    return this.db
      .prepare(
        `SELECT id, camera_id, path, started_at, ended_at FROM segments
         WHERE camera_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)
         ORDER BY started_at ASC`,
      )
      .all(cameraId, t1Ms, t0Ms) as SegmentRow[];
  }

  /**
   * Milliseconds of recorded footage actually covering [t0Ms, t1Ms) for one
   * camera — each overlapping segment clamped to the window and summed.
   *
   * Segment *count* cannot answer this: a camera that reconnects every 25s
   * produces more, shorter segments than a healthy one and would outrank it.
   * An open segment is measured up to nowMs, since that is how much of it has
   * been written so far.
   */
  capturedMsBetween(cameraId: string, t0Ms: number, t1Ms: number, nowMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(
           MIN(COALESCE(ended_at, ?), ?) - MAX(started_at, ?)
         ), 0) AS ms
         FROM segments
         WHERE camera_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)`,
      )
      .get(nowMs, t1Ms, t0Ms, cameraId, t1Ms, t0Ms) as { ms: number };
    return Math.max(0, row.ms);
  }

  insertEvent(event: NvrEvent): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO events
           (id, camera_id, kind, score, started_at, ended_at, clip_status, thumbnail_path, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.cameraId,
        event.kind,
        event.score,
        event.startedAt,
        event.endedAt ?? null,
        event.clipStatus,
        event.thumbnailPath ?? null,
        JSON.stringify(event.metadata),
      );
  }

  enqueueUpload(eventId: string, file: string): void {
    this.db
      .prepare("INSERT INTO upload_queue (event_id, file, created_at) VALUES (?, ?, ?)")
      .run(eventId, file, Date.now());
  }

  /** Oldest pending upload job, or undefined when the queue is empty. */
  nextUpload(): UploadQueueRow | undefined {
    return this.db
      .prepare(
        "SELECT id, event_id, file, attempts, created_at FROM upload_queue ORDER BY id ASC LIMIT 1",
      )
      .get() as UploadQueueRow | undefined;
  }

  bumpUploadAttempts(id: number): void {
    this.db.prepare("UPDATE upload_queue SET attempts = attempts + 1 WHERE id = ?").run(id);
  }

  deleteUpload(id: number): void {
    this.db.prepare("DELETE FROM upload_queue WHERE id = ?").run(id);
  }

  /** Drop the oldest jobs beyond `max`, returning the dropped rows (caller cleans files). */
  trimUploadQueue(max: number): UploadQueueRow[] {
    const dropped = this.db
      .prepare(
        `SELECT id, event_id, file, attempts, created_at FROM upload_queue
         ORDER BY id DESC LIMIT -1 OFFSET ?`,
      )
      .all(max) as UploadQueueRow[];
    for (const row of dropped) this.deleteUpload(row.id);
    return dropped;
  }

  /* ---------- Google Drive backup queue (mirrors upload_queue) ---------- */

  enqueueGdrive(eventId: string, file: string): void {
    this.db
      .prepare("INSERT INTO gdrive_queue (event_id, file, created_at) VALUES (?, ?, ?)")
      .run(eventId, file, Date.now());
  }

  /** Oldest pending Drive backup job, or undefined when the queue is empty. */
  nextGdrive(): GdriveQueueRow | undefined {
    return this.db
      .prepare(
        "SELECT id, event_id, file, attempts, created_at FROM gdrive_queue ORDER BY id ASC LIMIT 1",
      )
      .get() as GdriveQueueRow | undefined;
  }

  bumpGdriveAttempts(id: number): void {
    this.db.prepare("UPDATE gdrive_queue SET attempts = attempts + 1 WHERE id = ?").run(id);
  }

  deleteGdrive(id: number): void {
    this.db.prepare("DELETE FROM gdrive_queue WHERE id = ?").run(id);
  }

  countGdriveQueue(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM gdrive_queue").get() as { n: number };
    return row.n;
  }

  /** Drop the oldest jobs beyond `max`, returning the dropped rows (caller cleans files). */
  trimGdriveQueue(max: number): GdriveQueueRow[] {
    const dropped = this.db
      .prepare(
        `SELECT id, event_id, file, attempts, created_at FROM gdrive_queue
         ORDER BY id DESC LIMIT -1 OFFSET ?`,
      )
      .all(max) as GdriveQueueRow[];
    for (const row of dropped) this.deleteGdrive(row.id);
    return dropped;
  }

  /**
   * True while any queue (cloud upload or Drive backup) still references the
   * event — the shared clip dir under .clips/<eventId>/ must not be deleted
   * until this returns false.
   */
  clipReferenced(eventId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT EXISTS(SELECT 1 FROM upload_queue WHERE event_id = ?) +
                EXISTS(SELECT 1 FROM gdrive_queue WHERE event_id = ?) AS refs`,
      )
      .get(eventId, eventId) as { refs: number };
    return row.refs > 0;
  }

  getGdriveFolder(cacheKey: string): string | undefined {
    const row = this.db
      .prepare("SELECT folder_id FROM gdrive_folders WHERE cache_key = ?")
      .get(cacheKey) as { folder_id: string } | undefined;
    return row?.folder_id;
  }

  setGdriveFolder(cacheKey: string, folderId: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO gdrive_folders (cache_key, folder_id) VALUES (?, ?)")
      .run(cacheKey, folderId);
  }

  clearGdriveFolders(): void {
    this.db.prepare("DELETE FROM gdrive_folders").run();
  }

  getEvent(eventId: string): EventRow | undefined {
    return this.db
      .prepare(
        `SELECT id, camera_id, kind, score, started_at, ended_at, clip_status, thumbnail_path, metadata
         FROM events WHERE id = ?`,
      )
      .get(eventId) as EventRow | undefined;
  }

  /** Most recent events for the local UI, newest first. */
  recentEvents(limit: number): EventRow[] {
    return this.db
      .prepare(
        `SELECT id, camera_id, kind, score, started_at, ended_at, clip_status, thumbnail_path, metadata
         FROM events ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as EventRow[];
  }

  /**
   * Drop local event rows and dead upload/gdrive queue leftovers older than
   * cutoffMs. Returns the dropped queue rows so the caller can release any
   * clip dirs they still referenced.
   */
  pruneOldRows(cutoffMs: number): {
    events: number;
    uploads: UploadQueueRow[];
    gdrive: GdriveQueueRow[];
  } {
    const cutoffIso = new Date(cutoffMs).toISOString();
    const uploads = this.db
      .prepare(
        "SELECT id, event_id, file, attempts, created_at FROM upload_queue WHERE created_at < ?",
      )
      .all(cutoffMs) as UploadQueueRow[];
    for (const row of uploads) this.deleteUpload(row.id);
    const gdrive = this.db
      .prepare(
        "SELECT id, event_id, file, attempts, created_at FROM gdrive_queue WHERE created_at < ?",
      )
      .all(cutoffMs) as GdriveQueueRow[];
    for (const row of gdrive) this.deleteGdrive(row.id);
    const events = this.write(
      () => this.db.prepare("DELETE FROM events WHERE started_at < ?").run(cutoffIso).changes,
    );
    return { events, uploads, gdrive };
  }

  updateEventClipStatus(eventId: string, clipStatus: string, thumbnailPath?: string): void {
    if (thumbnailPath !== undefined) {
      this.db
        .prepare("UPDATE events SET clip_status = ?, thumbnail_path = ? WHERE id = ?")
        .run(clipStatus, thumbnailPath, eventId);
    } else {
      this.db.prepare("UPDATE events SET clip_status = ? WHERE id = ?").run(clipStatus, eventId);
    }
  }

  close(): void {
    this.db.close();
  }
}
