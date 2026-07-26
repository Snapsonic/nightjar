import assert from "node:assert/strict";
import { test } from "node:test";
import { rtspInputArgs } from "./ffmpeg.js";

test("rtspInputArgs never uses -rw_timeout", () => {
  // Regression guard: the RTSP demuxer rejects -rw_timeout with "Option not
  // found", so ffmpeg exits before opening the stream and every capture fails.
  assert.ok(!rtspInputArgs("rtsp://host/cam").includes("-rw_timeout"));
});

test("rtspInputArgs sets a socket timeout and the stream url", () => {
  const args = rtspInputArgs("rtsp://host/cam");
  const timeout = args.indexOf("-timeout");
  assert.ok(timeout >= 0, "expected a -timeout flag");
  assert.equal(args[timeout + 1], "30000000");
  assert.equal(args.at(-2), "-i");
  assert.equal(args.at(-1), "rtsp://host/cam");
});

test("rtspInputArgs forces TCP transport", () => {
  const args = rtspInputArgs("rtsp://host/cam");
  assert.equal(args[args.indexOf("-rtsp_transport") + 1], "tcp");
});
