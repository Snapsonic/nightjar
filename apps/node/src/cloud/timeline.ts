import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

/**
 * Cloud timeline exports: on-demand clips from the 24/7 recording store,
 * uploaded to the private "timeline-exports" bucket at
 * {nodeId}/{cameraId}/{fromMs}-{toMs}.mp4 and served via signed URLs.
 *
 * The storage surface is abstracted behind `TimelineStorage` so the logic is
 * testable without a Supabase project (the bucket/policies only exist once
 * migration 0006 is applied).
 */

export const TIMELINE_BUCKET = "timeline-exports";
export const TIMELINE_SIGNED_URL_TTL_S = 3_600;
/** Node-side cleanup deletes its own exports older than this. */
export const TIMELINE_EXPORT_MAX_AGE_MS = 24 * 3_600_000;

/** Minimal storage surface (subset of supabase-js Storage) — mockable in tests. */
export interface TimelineStorage {
  /** Signed URL for an existing object, or null when it does not exist. */
  createSignedUrl(objectPath: string, ttlSec: number): Promise<string | null>;
  upload(objectPath: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Immediate children of a folder (files carry createdAt; subfolders null). */
  list(prefix: string): Promise<{ name: string; createdAt: string | null }[]>;
  remove(objectPaths: string[]): Promise<void>;
}

export function timelineObjectPath(
  nodeId: string,
  cameraId: string,
  fromMs: number,
  toMs: number,
): string {
  return `${nodeId}/${cameraId}/${fromMs}-${toMs}.mp4`;
}

export interface ExportTimelineClipOptions {
  nodeId: string;
  cameraId: string;
  /** Already clamped/validated by the caller. */
  fromMs: number;
  toMs: number;
  /** Directory for the transient local mp4 (deleted after upload). */
  tmpDir: string;
  storage: TimelineStorage;
  /** Runs the actual ffmpeg export (recorder.exportRange). */
  exportRange: (fromMs: number, toMs: number, outPath: string) => Promise<void>;
}

/**
 * Export [fromMs, toMs) for a camera and return a signed URL. If the exact
 * object already exists in storage it is signed directly (no re-export); a
 * concurrent-upload conflict is likewise resolved by signing the winner.
 * The local temp file is always deleted.
 */
export async function exportTimelineClip(opts: ExportTimelineClipOptions): Promise<string> {
  const objectPath = timelineObjectPath(opts.nodeId, opts.cameraId, opts.fromMs, opts.toMs);

  const existing = await opts.storage.createSignedUrl(objectPath, TIMELINE_SIGNED_URL_TTL_S);
  if (existing) return existing;

  mkdirSync(opts.tmpDir, { recursive: true });
  const outPath = path.join(opts.tmpDir, `timeline-${randomUUID()}.mp4`);
  try {
    await opts.exportRange(opts.fromMs, opts.toMs, outPath);
    const bytes = readFileSync(outPath);
    try {
      await opts.storage.upload(objectPath, bytes, "video/mp4");
    } catch (err) {
      // Duplicate upload race — if the object is signable now, someone else won.
      const raced = await opts.storage.createSignedUrl(objectPath, TIMELINE_SIGNED_URL_TTL_S);
      if (raced) return raced;
      throw err;
    }
  } finally {
    try {
      unlinkSync(outPath);
    } catch {
      // never created / already gone
    }
  }

  const url = await opts.storage.createSignedUrl(objectPath, TIMELINE_SIGNED_URL_TTL_S);
  if (!url) throw new Error("uploaded timeline clip could not be signed");
  return url;
}

/**
 * Delete this node's timeline exports older than `maxAgeMs`. Walks the
 * {nodeId}/ prefix one folder level deep ({nodeId}/{cameraId}/file.mp4);
 * stray files directly under {nodeId}/ are aged out too. Returns the number
 * of objects removed.
 */
export async function cleanupTimelineExports(
  nodeId: string,
  storage: TimelineStorage,
  nowMs: number = Date.now(),
  maxAgeMs: number = TIMELINE_EXPORT_MAX_AGE_MS,
): Promise<number> {
  const isExpired = (createdAt: string | null): boolean => {
    if (!createdAt) return false;
    const created = Date.parse(createdAt);
    return Number.isFinite(created) && nowMs - created > maxAgeMs;
  };

  const expired: string[] = [];
  for (const entry of await storage.list(nodeId)) {
    if (entry.createdAt !== null) {
      // A file directly under {nodeId}/ (not the expected layout) — age it out.
      if (isExpired(entry.createdAt)) expired.push(`${nodeId}/${entry.name}`);
      continue;
    }
    const folder = `${nodeId}/${entry.name}`;
    for (const child of await storage.list(folder)) {
      if (isExpired(child.createdAt)) expired.push(`${folder}/${child.name}`);
    }
  }
  if (expired.length > 0) await storage.remove(expired);
  return expired.length;
}
