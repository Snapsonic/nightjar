import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NodeDb } from "../db.js";
import {
  CAPTURE_LIVENESS_MS,
  coverageFraction,
  isCaptureLive,
  isStreamMissingTail,
  PRUNE_FLOOR_MS,
} from "./recorder.js";

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

test("coverage distinguishes a churning camera that isCaptureLive calls healthy", () => {
  const { db, dir } = scratchDb();
  const now = 1_784_000_000_000;
  const windowMs = 600_000;
  const t0 = now - windowMs;
  try {
    // A camera that reconnects constantly: ten 25s captures spread over the
    // window. Every one of them is recent, so liveness is satisfied...
    for (let i = 0; i < 10; i++) {
      const startedAt = t0 + i * 60_000;
      db.endSegment(
        db.insertSegment(CAMERA_ID, `/rec/churn-${i}.mp4`, startedAt),
        startedAt + 25_000,
      );
    }
    assert.equal(isCaptureLive(db.latestSegmentAt(CAMERA_ID), now), true);
    // ...while less than half the window is actually on disk.
    const churning = coverageFraction(db.capturedMsBetween(CAMERA_ID, t0, now, now), windowMs);
    assert.equal(churning, 250_000 / windowMs);
    assert.ok(churning < 0.5, "a camera losing 35s a minute must not read as healthy");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capturedMsBetween clamps to the window and measures open segments to now", () => {
  const { db, dir } = scratchDb();
  const now = 1_784_000_000_000;
  const windowMs = 600_000;
  const t0 = now - windowMs;
  try {
    // Straddles the start of the window — only the part inside counts.
    db.endSegment(db.insertSegment(CAMERA_ID, "/rec/before.mp4", t0 - 40_000), t0 + 20_000);
    // Wholly outside — contributes nothing.
    db.endSegment(db.insertSegment(CAMERA_ID, "/rec/ancient.mp4", t0 - 300_000), t0 - 240_000);
    // Open (still being written): counted up to now, not to a phantom end.
    db.insertSegment(CAMERA_ID, "/rec/open.mp4", now - 30_000);
    // Another camera's footage must not leak in.
    db.endSegment(
      db.insertSegment("00000000-0000-0000-0000-000000000000", "/rec/other.mp4", t0),
      now,
    );

    assert.equal(db.capturedMsBetween(CAMERA_ID, t0, now, now), 20_000 + 30_000);
    // A fully covered window reads as exactly 1, never more.
    db.endSegment(db.insertSegment(CAMERA_ID, "/rec/full.mp4", t0 - 60_000), now + 60_000);
    assert.equal(
      coverageFraction(db.capturedMsBetween(CAMERA_ID, t0, now, now), windowMs),
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isStreamMissingTail recognises go2rtc's 404 for an unserved stream", () => {
  assert.ok(isStreamMissingTail("Error opening input files: Server returned 404 Not Found"));
  assert.ok(isStreamMissingTail("server returned 404 not found"));
});

test("isStreamMissingTail ignores unrelated capture failures", () => {
  // These recover on their own; treating them as a missing stream would mint
  // a new SDM stream for every ordinary blip.
  assert.ok(!isStreamMissingTail("[rtsp @ 0x1] RTP: PT=61: bad cseq 0001 expected=1efa"));
  assert.ok(!isStreamMissingTail("Could not write header (incorrect codec parameters ?)"));
  assert.ok(!isStreamMissingTail("Connection timed out"));
  assert.ok(!isStreamMissingTail(""));
});

test("scenery tracks survive a database reopen", () => {
  const { db, dir } = scratchDb();
  try {
    assert.deepEqual(db.loadSceneryTracks(), []);
    db.saveSceneryTracks([
      {
        camera_id: CAMERA_ID,
        kind: "person",
        x: 0.704, y: 0.002, w: 0.114, h: 0.577,
        seen: 244, missed: 509, tight: 244,
        first_ms: 1_000_000, last_ms: 1_400_000,
      },
    ]);
    const reopened = new NodeDb(dir);
    try {
      const rows = reopened.loadSceneryTracks();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.tight, 244);
      assert.equal(rows[0]?.x, 0.704);
      assert.equal(rows[0]?.kind, "person");
    } finally {
      reopened.close();
    }
    // Saving replaces wholesale — the model is the authority on what exists.
    db.saveSceneryTracks([]);
    assert.deepEqual(db.loadSceneryTracks(), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
