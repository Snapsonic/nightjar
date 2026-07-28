import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamStartGate } from "../backoff.js";
import type { Logger } from "../log.js";
import { NestCommandError, type NestBridge } from "./sdm.js";
import { NestStreamManager, withAuthToken, type StreamChange } from "./streams.js";

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

test("a new stream reports 'generated' so consumers get repointed", async () => {
  const { bridge } = bridgeStub(() => generateResult());
  const mgr = new NestStreamManager(bridge, silent, fastGate());
  const seen: StreamChange[] = [];
  mgr.onChange((c) => seen.push(c));

  await mgr.acquire("cam-1", "dev-1");

  assert.deepEqual(seen, [{ cameraId: "cam-1", reason: "generated" }]);
  mgr.stopAll();
});

test("refresh mints a new stream even though the current one is still valid", async () => {
  const { bridge, calls } = bridgeStub(() => generateResult());
  const mgr = new NestStreamManager(bridge, silent, fastGate());
  const first = await mgr.acquire("cam-1", "dev-1");

  await mgr.refresh("cam-1", "dev-1");

  assert.equal(calls.length, 2, "refresh must bypass the reuse check");
  assert.ok(mgr.urlFor("cam-1"));
  assert.equal(first, mgr.urlFor("cam-1")); // same stub URL, but freshly minted
  mgr.stopAll();
});

test("refresh is rate limited so a broken camera cannot spin on SDM", async () => {
  const { bridge, calls } = bridgeStub(() => generateResult());
  const mgr = new NestStreamManager(bridge, silent, fastGate());
  await mgr.acquire("cam-1", "dev-1");

  await mgr.refresh("cam-1", "dev-1");
  await mgr.refresh("cam-1", "dev-1");
  await mgr.refresh("cam-1", "dev-1");

  assert.equal(calls.length, 2, "only the first refresh should reach SDM");
  mgr.stopAll();
});

test("syncCameras re-acquires a stream that has actually lapsed", async () => {
  // Already expired on arrival: the renewal loop is gone and the reconcile is
  // the only thing that can notice.
  const { bridge, calls } = bridgeStub(() => generateResult(-1_000));
  const mgr = new NestStreamManager(bridge, silent, fastGate());

  await mgr.syncCameras([{ id: "cam-1", deviceId: "dev-1" }]);
  await mgr.syncCameras([{ id: "cam-1", deviceId: "dev-1" }]);

  assert.equal(calls.length, 2, "an expired stream must not be treated as live");
  mgr.stopAll();
});

test("syncCameras leaves a healthy stream alone", async () => {
  const { bridge, calls } = bridgeStub(() => generateResult());
  const mgr = new NestStreamManager(bridge, silent, fastGate());

  await mgr.syncCameras([{ id: "cam-1", deviceId: "dev-1" }]);
  await mgr.syncCameras([{ id: "cam-1", deviceId: "dev-1" }]);

  assert.equal(calls.length, 1, "reconcile must not churn healthy streams");
  mgr.stopAll();
});

test("refresh reports whether it actually minted a stream", async () => {
  const { bridge } = bridgeStub(() => generateResult());
  const mgr = new NestStreamManager(bridge, silent, fastGate());
  await mgr.acquire("cam-1", "dev-1");

  // First forced refresh acts; the second is inside the cooldown and must say
  // so, otherwise callers announce a refresh that never happened.
  assert.equal(await mgr.refresh("cam-1", "dev-1"), true);
  assert.equal(await mgr.refresh("cam-1", "dev-1"), false);
  mgr.stopAll();
});

test("refresh reports false when minting fails", async () => {
  const { bridge } = bridgeStub(() => new NestCommandError("boom", 500));
  const mgr = new NestStreamManager(bridge, silent, fastGate());
  assert.equal(await mgr.refresh("cam-1", "dev-1"), false);
  mgr.stopAll();
});
