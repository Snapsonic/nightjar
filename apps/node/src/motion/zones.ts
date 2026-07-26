import type { Detection, Zone } from "@nightjar/shared";

/**
 * Pure activity-zone geometry: point-in-polygon, polygon rasterization into
 * the 320x180 motion-analysis grid, detection-center filtering and per-zone
 * motion attribution. No I/O — everything here is unit-tested directly.
 */

/**
 * Ray-casting point-in-polygon over normalized coordinates. Points exactly on
 * a vertex/edge may land either way (fine for fuzzy camera zones).
 */
export function pointInPolygon(x: number, y: number, points: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i] as [number, number];
    const [xj, yj] = points[j] as [number, number];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Rasterize one zone polygon into a width x height mask (1 = inside).
 *  Pixel centers are sampled ((px + 0.5) / width), once per config change —
 *  57.6k point-in-polygon tests at 320x180, cheap. */
export function rasterizeZone(zone: Zone, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5) / height;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (pointInPolygon((x + 0.5) / width, ny, zone.points)) mask[row + x] = 1;
    }
  }
  return mask;
}

export interface ZoneMasks {
  /** Union mask over all zones, or null when zones is empty (whole frame active). */
  union: Uint8Array | null;
  /** Number of active pixels — the denominator for the motion trigger fraction. */
  activeCount: number;
  /** Per-zone masks, for attributing motion to the zone that changed most. */
  perZone: { id: string; mask: Uint8Array }[];
}

/** Build the union + per-zone masks for a camera's zones. Empty zones =>
 *  null union with the full frame as denominator (pre-zones behavior). */
export function buildZoneMasks(zones: readonly Zone[], width: number, height: number): ZoneMasks {
  const total = width * height;
  if (zones.length === 0) return { union: null, activeCount: total, perZone: [] };
  const union = new Uint8Array(total);
  const perZone: { id: string; mask: Uint8Array }[] = [];
  for (const zone of zones) {
    const mask = rasterizeZone(zone, width, height);
    for (let i = 0; i < total; i++) if (mask[i]) union[i] = 1;
    perZone.push({ id: zone.id, mask });
  }
  let activeCount = 0;
  for (let i = 0; i < total; i++) if (union[i]) activeCount++;
  return { union, activeCount, perZone };
}

export interface FrameDiff {
  /** Changed pixels inside the union mask. */
  changed: number;
  /** changed / activeCount (0 when the masks cover no pixels). */
  changedFraction: number;
  /** Changed-pixel count per zone id (empty when no zones). */
  perZoneChanged: Record<string, number>;
}

/**
 * One motion-analysis step: compares `frame` against the rolling background,
 * counting changed pixels only where the union mask is set, and updates the
 * background in place for ALL pixels (the background keeps learning outside
 * zones so toggling zones later needs no warm-up).
 */
export function diffFrame(
  frame: Uint8Array | Buffer,
  bg: Float32Array,
  masks: ZoneMasks,
  pixelThreshold: number,
  alpha: number,
): FrameDiff {
  const { union, perZone } = masks;
  const perZoneChanged: Record<string, number> = {};
  for (const zone of perZone) perZoneChanged[zone.id] = 0;
  let changed = 0;
  for (let i = 0; i < bg.length; i++) {
    const value = frame[i] as number;
    const prev = bg[i] as number;
    const diff = value - prev;
    bg[i] = prev + diff * alpha;
    if (diff <= pixelThreshold && diff >= -pixelThreshold) continue;
    if (union === null) {
      changed++;
      continue;
    }
    if (!union[i]) continue;
    changed++;
    for (const zone of perZone) {
      if (zone.mask[i]) perZoneChanged[zone.id] = (perZoneChanged[zone.id] as number) + 1;
    }
  }
  return {
    changed,
    changedFraction: masks.activeCount > 0 ? changed / masks.activeCount : 0,
    perZoneChanged,
  };
}

/** Zone id with the highest changed-pixel count (> 0), or null. */
export function topZoneId(perZoneChanged: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of Object.entries(perZoneChanged)) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

/** Zone ids whose polygon contains the detection box center ([x+w/2, y+h/2]). */
export function zoneIdsForBox(
  box: NonNullable<Detection["box"]>,
  zones: readonly Zone[],
): string[] {
  const [x, y, w, h] = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return zones.filter((zone) => pointInPolygon(cx, cy, zone.points)).map((zone) => zone.id);
}

/**
 * True when the detection should count: no zones configured, no box to test
 * (rare — keep it rather than silently drop), or box center inside some zone.
 */
export function detectionInZones(detection: Detection, zones: readonly Zone[]): boolean {
  if (zones.length === 0) return true;
  if (!detection.box) return true;
  return zoneIdsForBox(detection.box, zones).length > 0;
}
