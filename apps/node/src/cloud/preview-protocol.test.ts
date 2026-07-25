import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RealtimeMessage,
  TimelinePreviewReply,
  TimelinePreviewRequest,
} from "@nightjar/shared";

const CAMERA_ID = "2e324303-9e08-4c50-89f7-b850a7c1b765";

test("timeline_preview_request round-trips through RealtimeMessage", () => {
  const message = {
    type: "timeline_preview_request",
    requestId: "req-1",
    cameraId: CAMERA_ID,
    atMs: 1_784_000_000_000,
  };
  const viaUnion = RealtimeMessage.parse(JSON.parse(JSON.stringify(message)));
  assert.deepEqual(viaUnion, message);
  assert.deepEqual(TimelinePreviewRequest.parse(message), message);
});

test("timeline_preview_reply round-trips through RealtimeMessage", () => {
  const message = {
    type: "timeline_preview_reply",
    requestId: "req-1",
    url: "https://example.supabase.co/storage/v1/object/sign/snapshots/x.jpg?token=abc",
  };
  const viaUnion = RealtimeMessage.parse(JSON.parse(JSON.stringify(message)));
  assert.deepEqual(viaUnion, message);
  assert.deepEqual(TimelinePreviewReply.parse(message), message);
});

test("malformed preview messages are rejected", () => {
  assert.equal(
    RealtimeMessage.safeParse({
      type: "timeline_preview_request",
      requestId: "r",
      cameraId: "not-a-uuid",
      atMs: 1,
    }).success,
    false,
  );
  assert.equal(
    RealtimeMessage.safeParse({
      type: "timeline_preview_request",
      requestId: "r",
      cameraId: CAMERA_ID,
      atMs: -5,
    }).success,
    false,
  );
  assert.equal(
    RealtimeMessage.safeParse({
      type: "timeline_preview_request",
      requestId: "r",
      cameraId: CAMERA_ID,
      atMs: 1.5,
    }).success,
    false,
  );
  assert.equal(
    RealtimeMessage.safeParse({
      type: "timeline_preview_reply",
      requestId: "r",
      url: "not a url",
    }).success,
    false,
  );
});
