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

/**
 * Local SQLite state at ${DB_DIR}/nightjar.db (default /db).
 * Holds the recording segment index, a local mirror of events, and the
 * clip upload queue. Migration-on-open via PRAGMA user_version.
 */
export class NodeDb {
  readonly db: Database.Database;

  constructor(dbDir: string = process.env.DB_DIR ?? "/db") {
    mkdirSync(dbDir, { recursive: true });
    this.db = new Database(path.join(dbDir, "nightjar.db"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
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
  }

  insertSegment(cameraId: string, filePath: string, startedAtMs: number): number {
    const result = this.db
      .prepare("INSERT INTO segments (camera_id, path, started_at) VALUES (?, ?, ?)")
      .run(cameraId, filePath, startedAtMs);
    return Number(result.lastInsertRowid);
  }

  endSegment(id: number, endedAtMs: number): void {
    this.db.prepare("UPDATE segments SET ended_at = ? WHERE id = ?").run(endedAtMs, id);
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

  close(): void {
    this.db.close();
  }
}
