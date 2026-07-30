import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeStatusReply, RealtimeMessage } from "@nightjar/shared";

const CAMERA_ID = "2e324303-9e08-4c50-89f7-b850a7c1b765";

test("status_reply accepts the new optional capturing/lastSegmentAt fields", () => {
  const message = {
    type: "status_reply",
    requestId: "req-1",
    version: "0.1.0",
    uptimeSec: 42,
    cameras: [
      {
        cameraId: CAMERA_ID,
        online: true,
        recording: true,
        capturing: true,
        coverage: 0.93,
        lastSegmentAt: "2026-07-26T00:00:00.000Z",
      },
    ],
  };
  const viaUnion = RealtimeMessage.parse(JSON.parse(JSON.stringify(message)));
  assert.deepEqual(viaUnion, message);
  assert.deepEqual(NodeStatusReply.parse(message), message);
});

test("status_reply rejects a coverage outside 0..1", () => {
  const withCoverage = (coverage: number) => ({
    type: "status_reply",
    requestId: "req-1",
    version: "0.1.0",
    uptimeSec: 42,
    cameras: [{ cameraId: CAMERA_ID, online: true, recording: true, coverage }],
  });
  assert.ok(NodeStatusReply.safeParse(withCoverage(0)).success);
  assert.ok(NodeStatusReply.safeParse(withCoverage(1)).success);
  // A percentage that escaped its conversion must not reach the dashboard.
  assert.ok(!NodeStatusReply.safeParse(withCoverage(93)).success);
  assert.ok(!NodeStatusReply.safeParse(withCoverage(-0.1)).success);
});

test("status_reply without the new fields still parses (additive change)", () => {
  const message = {
    type: "status_reply",
    requestId: "req-1",
    version: "0.1.0",
    uptimeSec: 42,
    cameras: [{ cameraId: CAMERA_ID, online: false, recording: false }],
  };
  assert.deepEqual(NodeStatusReply.parse(message), message);
});
