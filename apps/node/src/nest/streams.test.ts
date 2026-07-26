import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamStartGate } from "../backoff.js";
import type { Logger } from "../log.js";
import { NestCommandError, type NestBridge } from "./sdm.js";
import { NestStreamManager, withAuthToken } from "./streams.js";

const silent: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silent,
} as unknown as Logger;

/** No pacing in tests — the gate's real delays would make them sleep. */
const fastGate = (): StreamStartGate => new StreamStartGate(0);

function bridgeStub(handler: (command: string, params: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const bridge = {
    executeCommand: async (
      _deviceId: string,
      command: string,
      params: Record<string, unknown> = {},
    ) => {
      calls.push({ command, params });
      const result = handler(command, params);
      if (result instanceof Error) throw result;
      return result as Record<string, unknown>;
    },
  } as unknown as NestBridge;
  return { bridge, calls };
}

const generateResult = (expiresInMs = 300_000) => ({
  streamUrls: { rtspUrl: "rtsps://stream.example/live?auth=token-1" },
  streamExtensionToken: "ext-1",
  streamToken: "token-1",
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
});

test("withAuthToken swaps the auth token and leaves the rest of the URL alone", () => {
  const out = withAuthToken("rtsps://host/live?auth=old&foo=bar", "new");
  assert.ok(out.includes("auth=new"));
  assert.ok(out.includes("foo=bar"));
  assert.ok(!out.includes("auth=old"));
});

test("withAuthToken passes through a URL it cannot parse", () => {
  assert.equal(withAuthToken("not a url", "new"), "not a url");
});

test("acquire generates once and reuses the live stream", async () => {
  const { bridge, calls } = bridgeStub(() => generateResult());
  const mgr = new NestStreamManager(bridge, silent, fastGate());

  const first = await mgr.acquire("cam-1", "dev-1");
  const second = await mgr.acquire("cam-1", "dev-1");

  assert.equal(first, second);
  assert.equal(calls.length, 1, "a live stream must not be regenerated");
  assert.equal(mgr.urlFor("cam-1"), first);
  mgr.stopAll();
});

test("acquire regenerates when the existing stream is near expiry", async () => {
  // 30s of life left is inside the 90s renewal margin, so it counts as stale.
  const { bridge, calls } = bridgeStub(() => generateResult(30_000));
  const mgr = new NestStreamManager(bridge, silent, fastGate());

  await mgr.acquire("cam-1", "dev-1");
  await mgr.acquire("cam-1", "dev-1");

  assert.equal(calls.length, 2);
  mgr.stopAll();
});

test("acquire regenerates when the camera points at a different device", async () => {
  const { bridge, calls } = bridgeStub(() => generateResult());
  const mgr = new NestStreamManager(bridge, silent, fastGate());

  await mgr.acquire("cam-1", "dev-1");
  await mgr.acquire("cam-1", "dev-2");

  assert.equal(calls.length, 2);
  mgr.stopAll();
});

test("syncCameras acquires new cameras and releases removed ones", async () => {
  const { bridge } = bridgeStub(() => generateResult());
  const mgr = new NestStreamManager(bridge, silent, fastGate());

  await mgr.syncCameras([
    { id: "cam-1", deviceId: "dev-1" },
    { id: "cam-2", deviceId: "dev-2" },
  ]);
  assert.ok(mgr.urlFor("cam-1"));
  assert.ok(mgr.urlFor("cam-2"));

  await mgr.syncCameras([{ id: "cam-1", deviceId: "dev-1" }]);
  assert.ok(mgr.urlFor("cam-1"));
  assert.equal(mgr.urlFor("cam-2"), null);
  mgr.stopAll();
});

test("syncCameras keeps going when one camera fails", async () => {
  const { bridge } = bridgeStub((_cmd, _params) => new Error("device offline"));
  const mgr = new NestStreamManager(bridge, silent, fastGate());

  // Must not reject: one bad camera cannot block the rest of the fleet.
  await mgr.syncCameras([{ id: "cam-1", deviceId: "dev-1" }]);
  assert.equal(mgr.urlFor("cam-1"), null);
  mgr.stopAll();
});

test("a rate-limited generate surfaces as NestCommandError.isRateLimited", async () => {
  const err = new NestCommandError("quota exceeded", 429);
  assert.ok(err.isRateLimited);
  assert.ok(!new NestCommandError("boom", 500).isRateLimited);

  const { bridge } = bridgeStub(() => err);
  const mgr = new NestStreamManager(bridge, silent, fastGate());
  await assert.rejects(() => mgr.acquire("cam-1", "dev-1"), /quota exceeded/);
  mgr.stopAll();
});

test("release stops tracking a camera", async () => {
  const { bridge } = bridgeStub(() => generateResult());
  const mgr = new NestStreamManager(bridge, silent, fastGate());
  await mgr.acquire("cam-1", "dev-1");
  mgr.release("cam-1");
  assert.equal(mgr.urlFor("cam-1"), null);
  mgr.stopAll();
});

test("acquire after stopAll refuses instead of minting an orphan stream", async () => {
  const { bridge, calls } = bridgeStub(() => generateResult());
  const mgr = new NestStreamManager(bridge, silent, fastGate());
  mgr.stopAll();
  await assert.rejects(() => mgr.acquire("cam-1", "dev-1"));
  assert.equal(calls.length, 0);
});
