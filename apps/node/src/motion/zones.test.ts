import assert from "node:assert/strict";
import { test } from "node:test";
import { CameraConfig, CameraPublic, RealtimeMessage, Zone } from "@nightjar/shared";
import {
  buildZoneMasks,
  detectionInZones,
  diffFrame,
  pointInPolygon,
  rasterizeZone,
  topZoneId,
  zoneIdsForBox,
} from "./zones.js";

const zone = (id: string, points: [number, number][], name = id): Zone => ({
  id,
  name,
  points,
  mode: "include",
});

/** Unit square quadrants used across tests. */
const LEFT_HALF: [number, number][] = [
  [0, 0],
  [0.5, 0],
  [0.5, 1],
  [0, 1],
];
const RIGHT_HALF: [number, number][] = [
  [0.5, 0],
  [1, 0],
  [1, 1],
  [0.5, 1],
];
const FULL: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/* ---------- point-in-polygon ---------- */

test("pointInPolygon: square basics", () => {
  const square: [number, number][] = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.75, 0.75],
    [0.25, 0.75],
  ];
  assert.equal(pointInPolygon(0.5, 0.5, square), true);
  assert.equal(pointInPolygon(0.1, 0.5, square), false);
  assert.equal(pointInPolygon(0.5, 0.1, square), false);
  assert.equal(pointInPolygon(0.9, 0.9, square), false);
  // Just inside the corners.
  assert.equal(pointInPolygon(0.26, 0.26, square), true);
  assert.equal(pointInPolygon(0.74, 0.74, square), true);
});

test("pointInPolygon: concave (L-shaped) polygon", () => {
  // L shape: full left column + bottom right — the top-right quadrant is a notch.
  const lShape: [number, number][] = [
    [0, 0],
    [0.5, 0],
    [0.5, 0.5],
    [1, 0.5],
    [1, 1],
    [0, 1],
  ];
  assert.equal(pointInPolygon(0.25, 0.25, lShape), true); // top-left arm
  assert.equal(pointInPolygon(0.75, 0.75, lShape), true); // bottom-right arm
  assert.equal(pointInPolygon(0.75, 0.25, lShape), false); // the notch
});

test("pointInPolygon: triangle edge cases", () => {
  const triangle: [number, number][] = [
    [0, 0],
    [1, 0],
    [0, 1],
  ];
  assert.equal(pointInPolygon(0.2, 0.2, triangle), true);
  assert.equal(pointInPolygon(0.8, 0.8, triangle), false);
  // On the hypotenuse-ish (x + y = 1): either verdict is acceptable for
  // fuzzy camera zones; just assert it does not throw and returns a boolean.
  assert.equal(typeof pointInPolygon(0.5, 0.5, triangle), "boolean");
});

/* ---------- rasterization ---------- */

test("rasterizeZone: full-frame polygon marks every pixel", () => {
  const mask = rasterizeZone(zone("full", FULL), 32, 18);
  assert.equal(mask.reduce((a, b) => a + b, 0), 32 * 18);
});

test("rasterizeZone: left half marks exactly half the pixels", () => {
  const width = 320;
  const height = 180;
  const mask = rasterizeZone(zone("left", LEFT_HALF), width, height);
  // Pixel centers at (x + 0.5)/320 < 0.5 -> exactly 160 columns.
  assert.equal(mask.reduce((a, b) => a + b, 0), (width / 2) * height);
  // Spot-check: left edge in, right edge out.
  assert.equal(mask[0], 1);
  assert.equal(mask[width - 1], 0);
});

test("buildZoneMasks: empty zones = full frame active with null union", () => {
  const masks = buildZoneMasks([], 320, 180);
  assert.equal(masks.union, null);
  assert.equal(masks.activeCount, 320 * 180);
  assert.deepEqual(masks.perZone, []);
});

test("buildZoneMasks: union of overlapping zones counts pixels once", () => {
  const overlapping: [number, number][] = [
    [0.25, 0],
    [0.75, 0],
    [0.75, 1],
    [0.25, 1],
  ]; // overlaps LEFT_HALF on [0.25, 0.5)
  const masks = buildZoneMasks([zone("a", LEFT_HALF), zone("b", overlapping)], 320, 180);
  assert.ok(masks.union);
  // Union covers x in [0, 0.75) -> 240 columns.
  assert.equal(masks.activeCount, 240 * 180);
  assert.equal(masks.perZone.length, 2);
});

/* ---------- masked frame diff + per-zone attribution ---------- */

test("diffFrame: changes outside the mask are ignored", () => {
  const width = 320;
  const height = 180;
  const total = width * height;
  const bg = new Float32Array(total); // all zeros
  const frame = new Uint8Array(total);
  // Light up a blob on the RIGHT side (x >= 0.75).
  for (let y = 0; y < height; y++) {
    for (let x = Math.floor(width * 0.75); x < width; x++) frame[y * width + x] = 255;
  }
  const leftMasks = buildZoneMasks([zone("left", LEFT_HALF)], width, height);
  const result = diffFrame(frame, bg, leftMasks, 25, 0.05);
  assert.equal(result.changed, 0);
  assert.equal(result.changedFraction, 0);
  assert.equal(result.perZoneChanged.left, 0);
});

test("diffFrame: masked fraction uses active pixels as denominator", () => {
  const width = 320;
  const height = 180;
  const total = width * height;
  const bg = new Float32Array(total);
  const frame = new Uint8Array(total);
  // Change every pixel in the left half.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width / 2; x++) frame[y * width + x] = 255;
  }
  const masks = buildZoneMasks([zone("left", LEFT_HALF)], width, height);
  const result = diffFrame(frame, bg, masks, 25, 0.05);
  assert.equal(result.changed, masks.activeCount);
  assert.equal(result.changedFraction, 1); // 100% of the ZONE changed
  // Unmasked baseline: same frame is only 50% of the full frame.
  const noZones = buildZoneMasks([], width, height);
  const baseline = diffFrame(frame, new Float32Array(total), noZones, 25, 0.05);
  assert.ok(Math.abs(baseline.changedFraction - 0.5) < 1e-9);
});

test("diffFrame: background keeps learning even outside zones", () => {
  const width = 8;
  const height = 4;
  const bg = new Float32Array(width * height);
  const frame = new Uint8Array(width * height).fill(100);
  const masks = buildZoneMasks([zone("left", LEFT_HALF)], width, height);
  diffFrame(frame, bg, masks, 25, 0.05);
  // Rightmost pixel is outside the zone but its background still moved.
  assert.ok((bg[width - 1] as number) > 0);
});

test("per-zone attribution: topZoneId picks the zone that changed most", () => {
  const width = 320;
  const height = 180;
  const bg = new Float32Array(width * height);
  const frame = new Uint8Array(width * height);
  // Big blob on the right, small blob on the left.
  for (let y = 0; y < height; y++) {
    for (let x = Math.floor(width * 0.5); x < width; x++) frame[y * width + x] = 255;
  }
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) frame[y * width + x] = 255;
  }
  const masks = buildZoneMasks([zone("left", LEFT_HALF), zone("right", RIGHT_HALF)], width, height);
  const result = diffFrame(frame, bg, masks, 25, 0.05);
  assert.equal(result.perZoneChanged.left, 100);
  assert.equal(result.perZoneChanged.right, (width / 2) * height);
  assert.equal(topZoneId(result.perZoneChanged), "right");
  assert.equal(topZoneId({ a: 0, b: 0 }), null);
  assert.equal(topZoneId({}), null);
});

/* ---------- detection-center filtering ---------- */

test("zoneIdsForBox: uses the box center", () => {
  const zones = [zone("left", LEFT_HALF), zone("right", RIGHT_HALF)];
  // Box spans the middle but its center (0.3, 0.5) is in the left zone.
  assert.deepEqual(zoneIdsForBox([0.1, 0.3, 0.4, 0.4], zones), ["left"]);
  // Center (0.8, 0.5) -> right.
  assert.deepEqual(zoneIdsForBox([0.7, 0.3, 0.2, 0.4], zones), ["right"]);
});

test("detectionInZones: empty zones or boxless detections always count", () => {
  const detection = { kind: "person" as const, score: 0.9, atMs: 0 };
  assert.equal(detectionInZones(detection, []), true);
  assert.equal(detectionInZones(detection, [zone("left", LEFT_HALF)]), true); // no box
  const inLeft = { ...detection, box: [0.1, 0.1, 0.2, 0.2] as [number, number, number, number] };
  const inRight = { ...detection, box: [0.7, 0.1, 0.2, 0.2] as [number, number, number, number] };
  assert.equal(detectionInZones(inLeft, [zone("left", LEFT_HALF)]), true);
  assert.equal(detectionInZones(inRight, [zone("left", LEFT_HALF)]), false);
});

/* ---------- zod round-trips ---------- */

test("Zone schema round-trips and rejects bad shapes", () => {
  const good = { id: "abc123", name: "Driveway", points: [[0, 0], [1, 0], [0.5, 1]] };
  const parsed = Zone.parse(good);
  assert.equal(parsed.mode, "include"); // default applied
  assert.deepEqual(Zone.parse(parsed), parsed); // round-trip stable
  assert.equal(Zone.safeParse({ ...good, points: [[0, 0], [1, 0]] }).success, false); // <3 pts
  assert.equal(
    Zone.safeParse({ ...good, points: [[0, 0], [2, 0], [0.5, 1]] }).success,
    false,
  ); // out of range
  assert.equal(Zone.safeParse({ ...good, name: "" }).success, false);
  assert.equal(Zone.safeParse({ ...good, mode: "exclude" }).success, false); // reserved
});

test("legacy CameraConfig without zones parses to zones: []", () => {
  const legacy = {
    id: "6a3c1f9e-0b1d-4c2e-9f3a-1234567890ab",
    name: "Front door",
    rtspUrl: "rtsp://user:pass@192.168.1.10/stream1",
  };
  const parsed = CameraConfig.parse(legacy);
  assert.deepEqual(parsed.zones, []);
  // Round-trip through JSON (what the config store persists) stays stable.
  assert.deepEqual(CameraConfig.parse(JSON.parse(JSON.stringify(parsed))), parsed);
});

test("CameraConfig with zones round-trips and CameraPublic passes them through", () => {
  const config = CameraConfig.parse({
    id: "6a3c1f9e-0b1d-4c2e-9f3a-1234567890ab",
    name: "Front door",
    rtspUrl: "rtsp://user:pass@192.168.1.10/stream1",
    zones: [{ id: "z1", name: "Porch", points: [[0, 0], [1, 0], [0.5, 1]] }],
  });
  assert.equal(config.zones.length, 1);
  const publicCamera = CameraPublic.parse(config);
  assert.deepEqual(publicCamera.zones, config.zones);
  // Credentials still stripped.
  assert.equal("rtspUrl" in publicCamera, false);
});

test("update_zones protocol messages parse via RealtimeMessage", () => {
  const request = RealtimeMessage.parse({
    type: "update_zones_request",
    requestId: "r1",
    cameraId: "6a3c1f9e-0b1d-4c2e-9f3a-1234567890ab",
    zones: [{ id: "z1", name: "Porch", points: [[0, 0], [1, 0], [0.5, 1]] }],
  });
  assert.equal(request.type, "update_zones_request");
  const reply = RealtimeMessage.parse({ type: "update_zones_reply", requestId: "r1", ok: true });
  assert.equal(reply.type, "update_zones_reply");
  // Invalid zone inside the request is rejected at the protocol boundary.
  assert.equal(
    RealtimeMessage.safeParse({
      type: "update_zones_request",
      requestId: "r1",
      cameraId: "6a3c1f9e-0b1d-4c2e-9f3a-1234567890ab",
      zones: [{ id: "z1", name: "Porch", points: [[0, 0], [1, 0]] }],
    }).success,
    false,
  );
});
