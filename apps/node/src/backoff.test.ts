import assert from "node:assert/strict";
import { test } from "node:test";
import { jitterMs, SPAWN_STAGGER_MS, StreamBreaker, StreamStartGate } from "./backoff.js";

test("jitterMs spans exactly [0.5x, 1.5x) of the base", () => {
  assert.equal(jitterMs(10_000, () => 0), 5_000);
  assert.equal(jitterMs(10_000, () => 0.5), 10_000);
  assert.equal(jitterMs(10_000, () => 0.999999), 15_000); // rounds up to the cap
  assert.equal(jitterMs(1_000, () => 0.25), 750);
});

test("jitterMs with the real RNG stays inside the bounds", () => {
  for (let i = 0; i < 1_000; i++) {
    const delay = jitterMs(60_000);
    assert.ok(delay >= 30_000, `${delay} below 0.5x`);
    assert.ok(delay <= 90_000, `${delay} above 1.5x`);
  }
});

test("spawn stagger constant spreads first spawns across ~a minute", () => {
  assert.equal(SPAWN_STAGGER_MS, 12_000);
});

test("breaker trips only after repeated failures across cameras", () => {
  let now = 0;
  const b = new StreamBreaker(3, 60_000, 300_000, () => now);
  assert.equal(b.recordFailure(), false);
  assert.equal(b.recordFailure(), false);
  assert.equal(b.recordFailure(), true, "third failure in the window trips it");
  assert.ok(b.isOpen);
  assert.equal(b.waitMs(), 300_000);
});

test("breaker stays closed when failures are spread beyond the window", () => {
  let now = 0;
  const b = new StreamBreaker(3, 60_000, 300_000, () => now);
  b.recordFailure();
  now += 61_000;
  b.recordFailure();
  now += 61_000;
  assert.equal(b.recordFailure(), false, "stale failures fall out of the window");
  assert.equal(b.isOpen, false);
});

test("a healthy capture closes the breaker immediately", () => {
  let now = 0;
  const b = new StreamBreaker(2, 60_000, 300_000, () => now);
  b.recordFailure();
  b.recordFailure();
  assert.ok(b.isOpen);
  b.recordSuccess();
  assert.equal(b.isOpen, false);
  assert.equal(b.waitMs(), 0);
});

test("start gate serializes turns and spaces them by the minimum gap", async () => {
  let now = 0;
  const slept: number[] = [];
  const gate = new StreamStartGate(
    8_000,
    () => now,
    async (ms) => {
      slept.push(ms);
      now += ms;
    },
  );
  const order: number[] = [];
  await Promise.all([
    gate.acquire().then(() => order.push(1)),
    gate.acquire().then(() => order.push(2)),
    gate.acquire().then(() => order.push(3)),
  ]);
  assert.deepEqual(order, [1, 2, 3], "turns are granted in request order");
  assert.deepEqual(slept, [8_000, 8_000], "each later start waits the full gap");
  assert.equal(now, 16_000);
});

test("start gate keeps granting turns after a caller throws", async () => {
  let now = 0;
  const gate = new StreamStartGate(1_000, () => now, async (ms) => { now += ms; });
  await gate.acquire().then(() => { throw new Error("caller exploded"); }).catch(() => {});
  let granted = false;
  await gate.acquire().then(() => { granted = true; });
  assert.ok(granted, "a rejected turn must not wedge the chain");
});
