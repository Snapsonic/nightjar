import type { Detection, EventKind } from "@nightjar/shared";
import type { SceneryTrackRow } from "../db.js";

/**
 * Learns the false positives that are part of the furniture.
 *
 * Two objects on this deployment score as people every time they are looked
 * at and have never once moved: a terracotta chiminea on the back deck
 * (0.50-0.62) and a strip of hedge beside it (0.86). They are not a model
 * failure that a better model fixed — YOLOX-s still reports the hedge at 0.86
 * — and they are not something motion filtering can catch, because by the time
 * detection runs the event has already opened.
 *
 * What separates them from a real person is time, not appearance. A person
 * crossing a deck is in one place for seconds; a person working there still
 * drifts, so their box moves. A chiminea occupies the same pixels every
 * thirty seconds for as long as the camera exists. So the test is presence:
 * a detection is scenery once a box of the same kind has been in essentially
 * the same spot, essentially continuously, for half an hour.
 *
 * The thresholds are deliberately far past anything a human does. Half an
 * hour of near-perfect stillness within a 60% IoU box is not a person standing
 * around; it is an object. Being wrong here means silently dropping a real
 * person, so the bar is set where that cannot plausibly happen rather than
 * where it would catch the most junk.
 */

/** Boxes overlapping this much are treated as the same object. */
const SCENERY_IOU = 0.6;
/** A track must span at least this long before it can count as scenery. */
const SCENERY_MIN_AGE_MS = 30 * 60_000;
/** ...and must have been seen in at least this fraction of its observations. */
const SCENERY_MIN_PRESENCE = 0.9;
/** ...over at least this many observations, so a brief burst cannot qualify. */
const SCENERY_MIN_SAMPLES = 40;
/** Tracks unseen this long are forgotten — the object left, or the view changed. */
const SCENERY_FORGET_MS = 10 * 60_000;
/**
 * The other way to be furniture: recurring in exactly one place, for hours.
 *
 * The presence rule above only catches objects the detector sees every single
 * time. The porch railing on Driveway 2 is not like that — it crosses the
 * score threshold only when the light suits it, so it appears in a small
 * fraction of passes and never approaches 90% presence. It still produced
 * three "person" events in half an hour, all with a box identical to three
 * decimal places, because it is a railing.
 *
 * So: enough sightings, spread over enough hours, all landing on the same box.
 * The IoU bar here is much tighter than SCENERY_IOU — a person who keeps
 * returning to a favourite spot still stands slightly differently each time,
 * while a railing reprojects onto the same pixels for ever. Fifty tight hits
 * across six hours is not somebody's habit; it is part of the house.
 */
const RECURRENT_IOU = 0.85;
const RECURRENT_MIN_TIGHT = 50;
const RECURRENT_MIN_AGE_MS = 6 * 3_600_000;
/** Established tracks survive longer gaps, since flickering is the whole point. */
const RECURRENT_FORGET_MS = 60 * 60_000;
/**
 * Overlap required before a track suppresses a DIFFERENT kind at its location.
 *
 * The porch railing on Driveway 2 is the case for this. The detector cannot
 * make up its mind about that corner: it calls it a vehicle most of the time
 * and a person occasionally, so the vehicle track reached 244 exact hits over
 * 399 minutes while the person track — keyed separately by kind — never
 * accumulated enough to qualify and the phantom kept firing. Splitting the
 * evidence by label was wrong when the label is the thing being got wrong.
 *
 * Cross-kind is a stronger claim than same-kind, so it needs a much tighter
 * box: essentially the same pixels, not merely the same area. A person walking
 * in front of a parked car has a far smaller box and does not match it.
 */
const CROSS_KIND_IOU = 0.85;
/** Only these kinds are ever suppressed; animals are the thing we are hunting. */
const SUPPRESSIBLE: ReadonlySet<EventKind> = new Set<EventKind>(["person", "vehicle", "package"]);

interface Track {
  kind: EventKind;
  /** Running mean box, so a slightly jittery detector still matches one track. */
  box: [number, number, number, number];
  seen: number;
  missed: number;
  /** Sightings that landed on the stored box almost exactly (RECURRENT_IOU). */
  tight: number;
  firstMs: number;
  lastMs: number;
}

export function boxIou(a: readonly number[], b: readonly number[]): number {
  const ax2 = a[0]! + a[2]!;
  const ay2 = a[1]! + a[3]!;
  const bx2 = b[0]! + b[2]!;
  const by2 = b[1]! + b[3]!;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0]!, b[0]!));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1]!, b[1]!));
  const inter = ix * iy;
  const union = a[2]! * a[3]! + b[2]! * b[3]! - inter;
  return union > 0 ? inter / union : 0;
}

export class SceneryModel {
  private readonly tracks = new Map<string, Track[]>();

  /**
   * Fold one full detection pass into the model.
   *
   * Call this with everything a sweep saw, including detections the sweep is
   * not going to act on — an object only proves it is furniture by being
   * present in observations nobody was interested in.
   */
  observe(cameraId: string, detections: readonly Detection[], nowMs: number): void {
    const existing = (this.tracks.get(cameraId) ?? []).filter(
      (t) => nowMs - t.lastMs < (t.tight >= RECURRENT_MIN_TIGHT ? RECURRENT_FORGET_MS : SCENERY_FORGET_MS),
    );
    const matched = new Set<Track>();
    for (const detection of detections) {
      if (!SUPPRESSIBLE.has(detection.kind) || !detection.box) continue;
      const box = detection.box as [number, number, number, number];
      const hit = existing.find(
        (t) => t.kind === detection.kind && !matched.has(t) && boxIou(t.box, box) >= SCENERY_IOU,
      );
      if (hit) {
        matched.add(hit);
        hit.seen++;
        if (boxIou(hit.box, box) >= RECURRENT_IOU) hit.tight++;
        hit.lastMs = nowMs;
        // Ease the stored box toward the observation so slow drift (a chair
        // nudged, the sun moving a shadow) does not split one object in two.
        for (let i = 0; i < 4; i++) hit.box[i] = hit.box[i]! * 0.9 + box[i]! * 0.1;
      } else {
        existing.push({
          kind: detection.kind,
          box: [...box],
          seen: 1,
          missed: 0,
          tight: 1,
          firstMs: nowMs,
          lastMs: nowMs,
        });
      }
    }
    // A track nobody matched this pass was absent — that is what stops a person
    // who lingers from ever reaching the presence threshold.
    for (const track of existing) {
      if (!matched.has(track) && track.lastMs !== nowMs) track.missed++;
    }
    this.tracks.set(cameraId, existing);
  }

  /**
   * Has this track earned the right to suppress, by either route?
   *
   * "Always there" catches the chiminea and the parked van. "Always in exactly
   * the same place, on and off, for hours" catches the porch railing, which the
   * detector only notices when the light suits it and which the presence rule
   * therefore never learned.
   */
  private qualifies(track: Track, nowMs: number): "constant" | "recurrent" | null {
    const age = track.lastMs - track.firstMs;
    const samples = track.seen + track.missed;
    if (
      nowMs - track.lastMs < SCENERY_FORGET_MS &&
      age >= SCENERY_MIN_AGE_MS &&
      samples >= SCENERY_MIN_SAMPLES &&
      track.seen / samples >= SCENERY_MIN_PRESENCE
    ) {
      return "constant";
    }
    if (
      nowMs - track.lastMs < RECURRENT_FORGET_MS &&
      age >= RECURRENT_MIN_AGE_MS &&
      track.tight >= RECURRENT_MIN_TIGHT
    ) {
      return "recurrent";
    }
    return null;
  }

  /** True once this box has been sitting still long enough to be furniture. */
  isScenery(cameraId: string, detection: Detection, nowMs: number): boolean {
    if (!SUPPRESSIBLE.has(detection.kind) || !detection.box) return false;
    for (const track of this.tracks.get(cameraId) ?? []) {
      // A qualified track suppresses its own kind over the usual overlap, and
      // any other suppressible kind only where the boxes are all but identical.
      const need = track.kind === detection.kind ? SCENERY_IOU : CROSS_KIND_IOU;
      if (boxIou(track.box, detection.box) < need) continue;
      if (this.qualifies(track, nowMs) !== null) return true;
    }
    return false;
  }

  /**
   * Everything learned so far, flat, for storage.
   *
   * Timestamps go out as they are. On the way back in they are compared
   * against the clock as usual, so a model restored after a long outage simply
   * reads as stale and suppresses nothing until it has watched again — which
   * is the honest answer, since the view may well have changed.
   */
  export(): SceneryTrackRow[] {
    const rows: SceneryTrackRow[] = [];
    for (const [cameraId, tracks] of this.tracks) {
      for (const t of tracks) {
        rows.push({
          camera_id: cameraId,
          kind: t.kind,
          x: t.box[0],
          y: t.box[1],
          w: t.box[2],
          h: t.box[3],
          seen: t.seen,
          missed: t.missed,
          tight: t.tight,
          first_ms: t.firstMs,
          last_ms: t.lastMs,
        });
      }
    }
    return rows;
  }

  /** Replace the model with stored rows (startup). */
  import(rows: readonly SceneryTrackRow[]): void {
    this.tracks.clear();
    for (const r of rows) {
      const list = this.tracks.get(r.camera_id) ?? [];
      list.push({
        kind: r.kind as EventKind,
        box: [r.x, r.y, r.w, r.h],
        seen: r.seen,
        missed: r.missed,
        tight: r.tight,
        firstMs: r.first_ms,
        lastMs: r.last_ms,
      });
      this.tracks.set(r.camera_id, list);
    }
  }

  /** Drop everything known about a camera (config change, camera removed). */
  forget(cameraId: string): void {
    this.tracks.delete(cameraId);
  }

  /** Scenery tracks currently held, for logging and tests. */
  describe(cameraId: string, nowMs: number): string[] {
    const out: string[] = [];
    for (const t of this.tracks.get(cameraId) ?? []) {
      const why = this.qualifies(t, nowMs);
      if (!why) continue;
      out.push(
        `${t.kind} at [${t.box.map((v) => v.toFixed(2)).join(",")}] ` +
          `(${why}: ${t.seen}/${t.seen + t.missed} seen, ${t.tight} exact, ` +
          `over ${Math.round((t.lastMs - t.firstMs) / 60_000)}min)`,
      );
    }
    return out;
  }
}
