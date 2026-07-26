import assert from "node:assert/strict";
import { test } from "node:test";
import { jitterMs, SPAWN_STAGGER_MS } from "./backoff.js";

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

test("spawn stagger constant is 3s per camera index", () => {
  assert.equal(SPAWN_STAGGER_MS, 3_000);
});
