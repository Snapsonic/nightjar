import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Detection } from "@nightjar/shared";
import { SceneryModel } from "./scenery.js";

const CAM = "7c0939a2-275a-4d1e-a7ba-70371fbe98a5";
const SWEEP = 30_000;

const det = (
  kind: string,
  box: [number, number, number, number],
  score = 0.86,
): Detection => ({ kind, score, box, atMs: 0 }) as Detection;

/** The real hedge box from the Backyard camera. */
const HEDGE: [number, number, number, number] = [0.704, 0.002, 0.114, 0.577];

/** Run n sweeps in which `dets` is present every time. */
function soak(model: SceneryModel, dets: Detection[], n: number, startMs = 1_000_000): number {
  let t = startMs;
  for (let i = 0; i < n; i++) {
    model.observe(CAM, dets, t);
    t += SWEEP;
  }
  return t;
}

describe("SceneryModel", () => {
  it("learns a hedge that has never moved and suppresses it", () => {
    const model = new SceneryModel();
    const hedge = det("person", HEDGE);
    // 30 min at 30s per sweep = 60 observations.
    const t = soak(model, [hedge], 61);
    assert.equal(model.isScenery(CAM, hedge, t), true);
    assert.match(model.describe(CAM, t)[0] ?? "", /^person at/);
  });

  it("does not suppress before it has watched long enough", () => {
    const model = new SceneryModel();
    const hedge = det("person", HEDGE);
    // 20 minutes is plenty of samples but not enough elapsed time.
    const t = soak(model, [hedge], 41);
    assert.equal(model.isScenery(CAM, hedge, t), false);
  });

  it("never suppresses a person who moves, however long they are around", () => {
    const model = new SceneryModel();
    let t = 1_000_000;
    // Someone working in the yard for two hours, drifting across the frame.
    for (let i = 0; i < 240; i++) {
      const x = 0.1 + (i % 40) * 0.015;
      model.observe(CAM, [det("person", [x, 0.3, 0.08, 0.35])], t);
      t += SWEEP;
    }
    assert.equal(model.isScenery(CAM, det("person", [0.4, 0.3, 0.08, 0.35]), t), false);
  });

  it("never suppresses someone who is merely often present", () => {
    const model = new SceneryModel();
    let t = 1_000_000;
    // Present in 3 of every 4 sweeps for two hours — well short of furniture.
    for (let i = 0; i < 240; i++) {
      model.observe(CAM, i % 4 === 3 ? [] : [det("person", HEDGE)], t);
      t += SWEEP;
    }
    assert.equal(model.isScenery(CAM, det("person", HEDGE), t), false);
  });

  it("a real person standing in front of the hedge is still suppressed there", () => {
    // Honest limitation, pinned so it is a decision and not a surprise: the
    // model suppresses a location for a kind, so a person who stops exactly
    // where the hedge is will be missed by this detection. They are still
    // caught anywhere else in frame, and motion still opens the event.
    const model = new SceneryModel();
    const t = soak(model, [det("person", HEDGE)], 61);
    assert.equal(model.isScenery(CAM, det("person", HEDGE, 0.95), t), true);
    assert.equal(model.isScenery(CAM, det("person", [0.2, 0.3, 0.1, 0.4], 0.95), t), false);
  });

  it("forgets an object that goes away", () => {
    const model = new SceneryModel();
    const chair = det("person", [0.1, 0.4, 0.08, 0.2]);
    const t = soak(model, [chair], 61);
    assert.equal(model.isScenery(CAM, chair, t), true);
    // Taken indoors: 11 minutes later nothing has matched it.
    assert.equal(model.isScenery(CAM, chair, t + 11 * 60_000), false);
  });

  it("never suppresses animals — they are the thing being hunted", () => {
    const model = new SceneryModel();
    const cat = det("cat", [0.5, 0.5, 0.05, 0.1], 0.6);
    const t = soak(model, [cat], 200);
    assert.equal(model.isScenery(CAM, cat, t), false);
  });

  it("keeps cameras separate", () => {
    const model = new SceneryModel();
    const hedge = det("person", HEDGE);
    const t = soak(model, [hedge], 61);
    assert.equal(model.isScenery("other-camera", hedge, t), false);
  });

  it("forget() clears a camera", () => {
    const model = new SceneryModel();
    const hedge = det("person", HEDGE);
    const t = soak(model, [hedge], 61);
    model.forget(CAM);
    assert.equal(model.isScenery(CAM, hedge, t), false);
  });
});
