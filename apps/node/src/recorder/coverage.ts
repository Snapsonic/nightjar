/**
 * Pure timeline helpers shared by the local recordings API and the cloud
 * timeline handlers. Kept free of I/O so they are trivially unit-testable.
 */

export interface CoverageSpan {
  startMs: number;
  endMs: number;
}

/** Minimal shape of a SQLite segment row that coverage math needs. */
export interface SegmentSpanRow {
  started_at: number;
  ended_at: number | null;
}

/** Segments this close together (ffmpeg segment rollover jitter) read as continuous. */
export const COVERAGE_MERGE_GAP_MS = 2_000;

/** Hard cap on a single timeline export. */
export const EXPORT_MAX_MS = 15 * 60_000;

/**
 * Merge segment rows into continuous coverage spans. An open segment
 * (ended_at NULL — still being written) covers up to `nowMs`. Adjacent spans
 * within `gapMs` of each other are joined; zero/negative-length rows are
 * dropped. Result is sorted ascending and non-overlapping.
 */
export function mergeCoverage(
  rows: readonly SegmentSpanRow[],
  nowMs: number,
  gapMs: number = COVERAGE_MERGE_GAP_MS,
): CoverageSpan[] {
  const spans = rows
    .map((row) => ({
      startMs: row.started_at,
      endMs: row.ended_at ?? Math.max(nowMs, row.started_at),
    }))
    .filter((span) => span.endMs > span.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: CoverageSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.startMs <= last.endMs + gapMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** Intersect spans with [clipStartMs, clipEndMs), dropping empty results. */
export function clipSpans(
  spans: readonly CoverageSpan[],
  clipStartMs: number,
  clipEndMs: number,
): CoverageSpan[] {
  return spans
    .map((span) => ({
      startMs: Math.max(span.startMs, clipStartMs),
      endMs: Math.min(span.endMs, clipEndMs),
    }))
    .filter((span) => span.endMs > span.startMs);
}

/**
 * Validate an export range and clamp its length to `maxMs` (keeping the
 * start). Returns null when the inputs are not finite numbers or the range is
 * empty/inverted.
 */
export function clampExportRange(
  fromMs: number,
  toMs: number,
  maxMs: number = EXPORT_MAX_MS,
): { fromMs: number; toMs: number } | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  if (fromMs < 0 || toMs <= fromMs) return null;
  return { fromMs, toMs: Math.min(toMs, fromMs + maxMs) };
}

/**
 * [start, end) unix-ms bounds of a local-time calendar day ("YYYY-MM-DD").
 * Uses the Date(y, m, d) constructor so DST days keep their real length.
 * Throws on a malformed day string.
 */
export function dayBoundsMs(day: string): { startMs: number; endMs: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error(`invalid day "${day}" (expected YYYY-MM-DD)`);
  const [, y, m, d] = match;
  const startMs = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  const endMs = new Date(Number(y), Number(m) - 1, Number(d) + 1).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error(`invalid day "${day}"`);
  }
  return { startMs, endMs };
}
