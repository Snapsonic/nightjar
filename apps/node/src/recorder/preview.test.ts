import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  pickPreviewSource,
  previewBucketMs,
  previewCachePath,
  prunePreviewCache,
  selectPreviewPrune,
} from "./preview.js";

test("previewBucketMs buckets to the minute", () => {
  assert.equal(previewBucketMs(0), 0);
  assert.equal(previewBucketMs(59_999), 0);
  assert.equal(previewBucketMs(60_000), 60_000);
  assert.equal(previewBucketMs(1_784_000_123_456), Math.floor(1_784_000_123_456 / 60_000) * 60_000);
});

test("previewCachePath is <recordings>/.previews/<cameraId>/<bucket>.jpg", () => {
  assert.equal(
    previewCachePath("/rec", "cam-1", 120_000),
    path.join("/rec", ".previews", "cam-1", "120000.jpg"),
  );
});

test("pickPreviewSource prefers the segment covering the bucket instant", () => {
  const segments = [
    { path: "a.mp4", started_at: 0, ended_at: 60_000 },
    { path: "b.mp4", started_at: 60_000, ended_at: 120_000 },
  ];
  const picked = pickPreviewSource(segments, 60_000, 200_000);
  assert.ok(picked);
  assert.equal(picked.segment.path, "b.mp4");
  assert.equal(picked.offsetS, 0);

  const mid = pickPreviewSource(segments, 0, 200_000);
  assert.ok(mid);
  assert.equal(mid.segment.path, "a.mp4");
});

test("pickPreviewSource computes the in-file offset", () => {
  const segments = [{ path: "a.mp4", started_at: 30_000, ended_at: 120_000 }];
  const picked = pickPreviewSource(segments, 60_000, 200_000);
  assert.ok(picked);
  assert.equal(picked.offsetS, 30);
});

test("pickPreviewSource falls back to a segment starting inside the minute", () => {
  const segments = [{ path: "late.mp4", started_at: 90_000, ended_at: 150_000 }];
  const picked = pickPreviewSource(segments, 60_000, 200_000);
  assert.ok(picked);
  assert.equal(picked.segment.path, "late.mp4");
  assert.equal(picked.offsetS, 0);
});

test("pickPreviewSource treats an open segment as covering up to now", () => {
  const segments = [{ path: "open.mp4", started_at: 0, ended_at: null }];
  assert.ok(pickPreviewSource(segments, 60_000, 90_000));
  assert.equal(pickPreviewSource(segments, 120_000, 90_000), null);
});

test("pickPreviewSource returns null for no usable segments", () => {
  assert.equal(pickPreviewSource([], 60_000, 200_000), null);
  const outside = [{ path: "x.mp4", started_at: 200_000, ended_at: 260_000 }];
  assert.equal(pickPreviewSource(outside, 60_000, 300_000), null);
});

test("selectPreviewPrune keeps newest maxFiles, returns oldest to delete", () => {
  const files = [
    { path: "c", mtimeMs: 300 },
    { path: "a", mtimeMs: 100 },
    { path: "b", mtimeMs: 200 },
    { path: "d", mtimeMs: 400 },
  ];
  assert.deepEqual(selectPreviewPrune(files, 2), ["a", "b"]);
  assert.deepEqual(selectPreviewPrune(files, 4), []);
  assert.deepEqual(selectPreviewPrune(files, 0), ["a", "b", "c", "d"]);
  assert.deepEqual(selectPreviewPrune([], 5), []);
});

test("prunePreviewCache deletes oldest files across camera dirs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nj-previews-"));
  try {
    const mk = (camera: string, name: string, ageSec: number) => {
      const dir = path.join(root, camera);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      writeFileSync(file, "jpg");
      const t = (Date.now() - ageSec * 1000) / 1000;
      utimesSync(file, t, t);
      return file;
    };
    mk("cam-a", "60000.jpg", 300); // oldest
    mk("cam-a", "120000.jpg", 200);
    mk("cam-b", "180000.jpg", 100);
    mk("cam-b", "240000.jpg", 10); // newest
    // Non-matching names are never pruned.
    mk("cam-b", "999.jpg.123.tmp.jpg", 10_000);

    const removed = prunePreviewCache(root, 2);
    assert.equal(removed, 2);
    assert.deepEqual(readdirSync(path.join(root, "cam-a")).sort(), []);
    assert.deepEqual(
      readdirSync(path.join(root, "cam-b")).sort(),
      ["180000.jpg", "240000.jpg", "999.jpg.123.tmp.jpg"].sort(),
    );

    // Under the cap: nothing removed; missing root: no throw.
    assert.equal(prunePreviewCache(root, 100), 0);
    assert.equal(prunePreviewCache(path.join(root, "nope"), 100), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
