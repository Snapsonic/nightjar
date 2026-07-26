import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NodeDb } from "../db.js";
import { CAPTURE_LIVENESS_MS, isCaptureLive, PRUNE_FLOOR_MS } from "./recorder.js";

const CAMERA_ID = "2e324303-9e08-4c50-89f7-b850a7c1b765";

function scratchDb(): { db: NodeDb; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "nightjar-recorder-test-"));
  return { db: new NodeDb(dir), dir };
}

test("isCaptureLive: fresh segment within 3x segment duration counts as live", () => {
  const now = 1_784_000_000_000;
  assert.equal(CAPTURE_LIVENESS_MS, 180_000);
  assert.equal(isCaptureLive(now, now), true);
  assert.equal(isCaptureLive(now - CAPTURE_LIVENESS_MS, now), true); // boundary inclusive
  assert.equal(isCaptureLive(now - CAPTURE_LIVENESS_MS - 1, now), false);
  assert.equal(isCaptureLive(null, now), false); // never recorded
});

test("latestSegmentAt reports the newest indexed instant (open segments included)", () => {
  const { db, dir } = scratchDb();
  try {
    assert.equal(db.latestSegmentAt(CAMERA_ID), null);
    const closed = db.insertSegment(CAMERA_ID, "/rec/a.mp4", 1_000);
    db.endSegment(closed, 61_000);
    // Open segment (ended_at NULL) counts via its started_at.
    db.insertSegment(CAMERA_ID, "/rec/b.mp4", 61_000);
    assert.equal(db.latestSegmentAt(CAMERA_ID), 61_000);
    db.insertSegment("00000000-0000-0000-0000-000000000000", "/rec/other.mp4", 999_000);
    assert.equal(db.latestSegmentAt(CAMERA_ID), 61_000); // per-camera
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watermark prune candidate selection never picks segments under the 24h floor", () => {
  const { db, dir } = scratchDb();
  const now = Date.now();
  try {
    const oldId = db.insertSegment(CAMERA_ID, "/rec/old.mp4", now - PRUNE_FLOOR_MS - 3_600_000);
    db.endSegment(oldId, now - PRUNE_FLOOR_MS - 3_540_000);
    const freshId = db.insertSegment(CAMERA_ID, "/rec/fresh.mp4", now - 3_600_000);
    db.endSegment(freshId, now - 3_540_000);

    // The watermark loop asks for segments started before the floor only.
    const victims = db.segmentsStartedBefore(now - PRUNE_FLOOR_MS, 10);
    assert.deepEqual(
      victims.map((row) => row.path),
      ["/rec/old.mp4"],
    );

    // Once the old segment is gone, nothing qualifies — the floor holds even
    // under watermark pressure.
    db.deleteSegment(oldId);
    assert.equal(db.segmentsStartedBefore(now - PRUNE_FLOOR_MS, 10).length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneOldRows drops 30-day-old events and queue leftovers, keeps fresh ones", () => {
  const { db, dir } = scratchDb();
  const now = Date.now();
  const old = new Date(now - 31 * 86_400_000).toISOString();
  const fresh = new Date(now - 86_400_000).toISOString();
  try {
    for (const [id, startedAt] of [
      ["11111111-1111-1111-1111-111111111111", old],
      ["22222222-2222-2222-2222-222222222222", fresh],
    ] as const) {
      db.insertEvent({
        id,
        cameraId: CAMERA_ID,
        kind: "motion",
        score: 0.5,
        startedAt,
        clipStatus: "local",
        metadata: {},
      });
    }
    db.enqueueUpload("11111111-1111-1111-1111-111111111111", "/rec/.clips/old");
    db.db
      .prepare("UPDATE upload_queue SET created_at = ?")
      .run(now - 31 * 86_400_000);
    db.enqueueUpload("22222222-2222-2222-2222-222222222222", "/rec/.clips/fresh");

    const dropped = db.pruneOldRows(now - 30 * 86_400_000);
    assert.equal(dropped.events, 1);
    assert.equal(dropped.uploads.length, 1);
    assert.equal(dropped.uploads[0]?.event_id, "11111111-1111-1111-1111-111111111111");
    assert.equal(dropped.gdrive.length, 0);
    assert.equal(db.getEvent("11111111-1111-1111-1111-111111111111"), undefined);
    assert.ok(db.getEvent("22222222-2222-2222-2222-222222222222"));
    assert.equal(db.nextUpload()?.event_id, "22222222-2222-2222-2222-222222222222");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
