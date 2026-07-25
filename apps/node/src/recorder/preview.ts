import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "../log.js";

const execFileAsync = promisify(execFile);

/**
 * Timeline hover previews: single JPEG frames extracted from the 24/7
 * recording store, cached on disk at
 * <recordings>/.previews/<cameraId>/<minuteBucketMs>.jpg.
 *
 * Requests are bucketed to the minute so scrubbing within one minute is a
 * cache hit; the cache is capped by pruning oldest-mtime files. The pure
 * helpers (bucketing, source picking, prune selection) are unit-testable
 * without ffmpeg or a filesystem.
 */

export const PREVIEW_BUCKET_MS = 60_000;
export const PREVIEW_CACHE_MAX_FILES = 2_000;
export const PREVIEW_WIDTH = 320;
/** ffmpeg -q:v for the JPEG (2 best … 31 worst). */
export const PREVIEW_JPEG_Q = 7;

/** Bucket an instant to its minute (cache key + extraction target). */
export function previewBucketMs(atMs: number): number {
  return Math.floor(atMs / PREVIEW_BUCKET_MS) * PREVIEW_BUCKET_MS;
}

/** Minimal segment shape the preview picker needs. */
export interface PreviewSegment {
  path: string;
  started_at: number; // unix ms
  ended_at: number | null; // null while still being written
}

/**
 * Pick the segment + in-file offset for a minute bucket. Prefers the segment
 * that covers the bucket instant itself; otherwise the first segment starting
 * inside the bucket's minute (frame taken at its start). Returns null when
 * nothing in `segments` (already filtered to the bucket window) is usable.
 */
export function pickPreviewSource(
  segments: readonly PreviewSegment[],
  bucketMs: number,
  nowMs: number = Date.now(),
): { segment: PreviewSegment; offsetS: number } | null {
  const sorted = [...segments].sort((a, b) => a.started_at - b.started_at);
  for (const segment of sorted) {
    const endMs = segment.ended_at ?? Math.max(nowMs, segment.started_at);
    if (segment.started_at <= bucketMs && bucketMs < endMs) {
      return { segment, offsetS: (bucketMs - segment.started_at) / 1000 };
    }
  }
  const later = sorted.find(
    (segment) => segment.started_at >= bucketMs && segment.started_at < bucketMs + PREVIEW_BUCKET_MS,
  );
  return later ? { segment: later, offsetS: 0 } : null;
}

/**
 * Given cache files (path + mtime), the paths to delete so at most `maxFiles`
 * remain, oldest first. Pure — the caller stats and unlinks.
 */
export function selectPreviewPrune(
  files: readonly { path: string; mtimeMs: number }[],
  maxFiles: number,
): string[] {
  if (files.length <= maxFiles) return [];
  return [...files]
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, files.length - maxFiles)
    .map((file) => file.path);
}

export function previewsRoot(recordingsDir: string): string {
  return path.join(recordingsDir, ".previews");
}

export function previewCachePath(
  recordingsDir: string,
  cameraId: string,
  bucketMs: number,
): string {
  return path.join(previewsRoot(recordingsDir), cameraId, `${bucketMs}.jpg`);
}

/** Prune the on-disk preview cache to `maxFiles` (oldest mtime first). */
export function prunePreviewCache(
  root: string,
  maxFiles: number = PREVIEW_CACHE_MAX_FILES,
): number {
  let entries: { path: string; mtimeMs: number }[];
  try {
    entries = readdirSync(root)
      .flatMap((cameraDir) => {
        const dir = path.join(root, cameraDir);
        try {
          return readdirSync(dir)
            .filter((name) => /^\d+\.jpg$/.test(name))
            .map((name) => path.join(dir, name));
        } catch {
          return []; // not a directory / vanished
        }
      })
      .flatMap((file) => {
        try {
          return [{ path: file, mtimeMs: statSync(file).mtimeMs }];
        } catch {
          return [];
        }
      });
  } catch {
    return 0; // cache root does not exist yet
  }
  const doomed = selectPreviewPrune(entries, maxFiles);
  let removed = 0;
  for (const file of doomed) {
    try {
      unlinkSync(file);
      removed++;
    } catch {
      // already gone
    }
  }
  return removed;
}

export interface PreviewDeps {
  recordingsDir: string;
  /** Segments overlapping [t0Ms, t1Ms) for a camera (the SQLite index). */
  segmentsBetween(cameraId: string, t0Ms: number, t1Ms: number): PreviewSegment[];
  log: Logger;
}

/**
 * Absolute path of the cached preview JPEG for (cameraId, atMs), extracting
 * it with ffmpeg on a cache miss. Returns null when no recording covers the
 * minute (or the frame cannot be decoded). Never throws for "no coverage".
 */
export async function getPreviewFrame(
  deps: PreviewDeps,
  cameraId: string,
  atMs: number,
): Promise<string | null> {
  const bucketMs = previewBucketMs(atMs);
  const cachePath = previewCachePath(deps.recordingsDir, cameraId, bucketMs);
  try {
    if (statSync(cachePath).size > 0) {
      deps.log.debug(`preview cache hit ${cameraId}/${bucketMs}`);
      return cachePath;
    }
  } catch {
    // cache miss
  }

  const segments = deps.segmentsBetween(cameraId, bucketMs, bucketMs + PREVIEW_BUCKET_MS).filter(
    (segment) => {
      try {
        // A just-opened segment holds only its ftyp box for an instant.
        return statSync(segment.path).size > 1024;
      } catch {
        return false;
      }
    },
  );
  const source = pickPreviewSource(segments, bucketMs);
  if (!source) return null;

  mkdirSync(path.dirname(cachePath), { recursive: true });
  // Write to a temp name then rename so a concurrent reader never sees a
  // partial JPEG (the .tmp suffix also keeps it out of the prune pattern).
  const tmpPath = `${cachePath}.${process.pid}.tmp.jpg`;
  try {
    // prettier-ignore
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin", "-loglevel", "error", "-y",
        ...(source.offsetS > 0 ? ["-ss", source.offsetS.toFixed(3)] : []),
        "-i", source.segment.path,
        "-frames:v", "1",
        "-vf", `scale=${PREVIEW_WIDTH}:-2`,
        "-q:v", String(PREVIEW_JPEG_Q),
        tmpPath,
      ],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    if (statSync(tmpPath).size === 0) throw new Error("empty preview frame");
    renameSync(tmpPath, cachePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // never created
    }
    deps.log.debug(
      `preview extract failed for ${cameraId}@${bucketMs}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  const removed = prunePreviewCache(previewsRoot(deps.recordingsDir));
  if (removed > 0) deps.log.debug(`preview cache pruned ${removed} file(s)`);
  deps.log.debug(`preview extracted ${cameraId}/${bucketMs}`);
  return cachePath;
}
