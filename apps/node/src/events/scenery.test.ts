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

  it("never suppresses someone often present who is actually moving", () => {
    const model = new SceneryModel();
    let t = 1_000_000;
    // Present in 3 of every 4 sweeps for two hours, shifting a little each
    // time. Frequency is not the test — a person is never pixel-identical.
    for (let i = 0; i < 240; i++) {
      const j = (i % 9) * 0.01;
      model.observe(CAM, i % 4 === 3 ? [] : [det("person", [0.3 + j, 0.35 + j, 0.1, 0.3])], t);
      t += SWEEP;
    }
    assert.equal(model.isScenery(CAM, det("person", [0.3, 0.35, 0.1, 0.3]), t), false);
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

describe("SceneryModel — flickering objects (the porch railing)", () => {
  /** The real Driveway 2 box that produced three "person" events in 25 min. */
  const RAILING: [number, number, number, number] = [0.0006, 0.6724, 0.2887, 0.325];

  it("learns a railing the detector only notices some of the time", () => {
    const model = new SceneryModel();
    let t = 1_000_000;
    // Eight hours of sweeps; the railing crosses the score threshold in only
    // one pass out of six, so presence never comes close to 90%.
    for (let i = 0; i < 960; i++) {
      model.observe(CAM, i % 6 === 0 ? [det("person", RAILING, 0.53)] : [], t);
      t += SWEEP;
    }
    assert.equal(model.isScenery(CAM, det("person", RAILING, 0.53), t), true);
    assert.match(model.describe(CAM, t)[0] ?? "", /recurrent/);
  });

  it("is not fooled by a person who keeps returning to roughly one spot", () => {
    const model = new SceneryModel();
    let t = 1_000_000;
    // Someone at the front door many times over eight hours, standing a little
    // differently each time — overlapping enough to be one track, never exact.
    for (let i = 0; i < 960; i++) {
      if (i % 6 === 0) {
        const jitter = ((i / 6) % 5) * 0.02;
        model.observe(CAM, [det("person", [0.3 + jitter, 0.4 + jitter, 0.12, 0.3])], t);
      } else {
        model.observe(CAM, [], t);
      }
      t += SWEEP;
    }
    assert.equal(model.isScenery(CAM, det("person", [0.3, 0.4, 0.12, 0.3]), t), false);
  });

  it("needs sustained evidence, not one dense burst", () => {
    const model = new SceneryModel();
    let t = 1_000_000;
    // 40 tight hits crammed into forty minutes — under every age floor.
    for (let i = 0; i < 80; i++) {
      model.observe(CAM, i % 2 === 0 ? [det("person", RAILING)] : [], t);
      t += SWEEP;
    }
    assert.equal(model.isScenery(CAM, det("person", RAILING), t), false);
  });

  it("still refuses to suppress animals however often they recur", () => {
    const model = new SceneryModel();
    let t = 1_000_000;
    for (let i = 0; i < 960; i++) {
      model.observe(CAM, [det("cat", [0.5, 0.5, 0.05, 0.1], 0.6)], t);
      t += SWEEP;
    }
    assert.equal(model.isScenery(CAM, det("cat", [0.5, 0.5, 0.05, 0.1], 0.6), t), false);
  });

  it("forgets a recurrent track once it is really gone", () => {
    const model = new SceneryModel();
    let t = 1_000_000;
    for (let i = 0; i < 960; i++) {
      model.observe(CAM, i % 6 === 0 ? [det("person", RAILING)] : [], t);
      t += SWEEP;
    }
    assert.equal(model.isScenery(CAM, det("person", RAILING), t), true);
    // Railing removed: nothing matches it for over an hour.
    assert.equal(model.isScenery(CAM, det("person", RAILING), t + 61 * 60_000), false);
  });
});

describe("SceneryModel — cross-kind suppression", () => {
  const CORNER: [number, number, number, number] = [0.0006, 0.6724, 0.2887, 0.325];

  it("a qualified vehicle track suppresses a person at the same exact box", () => {
    // The real Driveway 2 failure: the detector called that corner a vehicle
    // 244 times and a person occasionally, so the person track never qualified
    // on its own and the phantom kept firing.
    const model = new SceneryModel();
    const t = soak(model, [det("vehicle", CORNER)], 61);
    assert.equal(model.isScenery(CAM, det("person", CORNER, 0.53), t), true);
  });

  it("does not suppress a different kind merely overlapping the same area", () => {
    // A person in front of a parked car overlaps it but is much smaller — the
    // cross-kind bar is near-identical pixels, not shared ground.
    const model = new SceneryModel();
    const car: [number, number, number, number] = [0.2, 0.2, 0.5, 0.6];
    const t = soak(model, [det("vehicle", car)], 61);
    assert.equal(model.isScenery(CAM, det("person", [0.3, 0.45, 0.1, 0.35], 0.8), t), false);
  });

  it("cross-kind still never reaches animals", () => {
    const model = new SceneryModel();
    const t = soak(model, [det("vehicle", CORNER)], 61);
    assert.equal(model.isScenery(CAM, det("cat", CORNER, 0.6), t), false);
  });
});

describe("SceneryModel — surviving a restart", () => {
  it("a learned track still suppresses after export/import", () => {
    // The point of persisting: the model needs 30 minutes to call something
    // furniture, which is longer than the gap between two deploys, so in
    // memory alone it never finished learning.
    const before = new SceneryModel();
    const hedge = det("person", HEDGE);
    const t = soak(before, [hedge], 61);
    assert.equal(before.isScenery(CAM, hedge, t), true);

    const after = new SceneryModel();
    after.import(before.export());
    assert.equal(after.isScenery(CAM, hedge, t), true);
  });

  it("round-trips the counters the recurrence rule depends on", () => {
    const before = new SceneryModel();
    let t = 1_000_000;
    for (let i = 0; i < 960; i++) {
      before.observe(CAM, i % 6 === 0 ? [det("person", HEDGE)] : [], t);
      t += SWEEP;
    }
    const after = new SceneryModel();
    after.import(before.export());
    assert.deepEqual(after.describe(CAM, t), before.describe(CAM, t));
    assert.match(after.describe(CAM, t)[0] ?? "", /recurrent/);
  });

  it("a model restored after a long outage suppresses nothing", () => {
    const before = new SceneryModel();
    const hedge = det("person", HEDGE);
    const t = soak(before, [hedge], 61);
    const after = new SceneryModel();
    after.import(before.export());
    // Two hours later nothing has re-confirmed it; the view may have changed.
    assert.equal(after.isScenery(CAM, hedge, t + 2 * 3_600_000), false);
  });

  it("keeps learning from where it left off", () => {
    const before = new SceneryModel();
    let t = soak(before, [det("person", HEDGE)], 30); // not yet qualified
    assert.equal(before.isScenery(CAM, det("person", HEDGE), t), false);

    const after = new SceneryModel();
    after.import(before.export());
    for (let i = 0; i < 31; i++) {
      after.observe(CAM, [det("person", HEDGE)], t);
      t += SWEEP;
    }
    assert.equal(after.isScenery(CAM, det("person", HEDGE), t), true);
  });
});

describe("SceneryModel — rigid position (the Driveway phantom)", () => {
  /** The real box, which fired three person alerts in nine minutes. */
  const PHANTOM: [number, number, number, number] = [0.639, 0.453, 0.03, 0.08];

  it("suppresses an object seen only sometimes but always in the same pixels", () => {
    // Reproduces the live counters exactly: 63 sightings across 83 minutes,
    // every one of them tight, presence only 42%.
    const model = new SceneryModel();
    let t = 1_000_000;
    for (let i = 0; i < 151; i++) {
      model.observe(CAM, i % 12 < 5 ? [det("person", PHANTOM, 0.58)] : [], t);
      t += SWEEP;
    }
    assert.equal(model.isScenery(CAM, det("person", PHANTOM, 0.58), t), true);
    assert.match(model.describe(CAM, t)[0] ?? "", /rigid/);
  });

  it("is not fooled by someone detected often in slightly different places", () => {
    const model = new SceneryModel();
    let t = 1_000_000;
    for (let i = 0; i < 151; i++) {
      // Same doorway, never the same stance — overlapping enough to stay one
      // track, never tight enough to look rigid.
      const j = (i % 7) * 0.012;
      model.observe(CAM, i % 12 < 5 ? [det("person", [0.3 + j, 0.4 + j, 0.12, 0.3])] : [], t);
      t += SWEEP;
    }
    assert.equal(model.isScenery(CAM, det("person", [0.3, 0.4, 0.12, 0.3]), t), false);
  });

  it("needs more than a brief burst, however identical", () => {
    const model = new SceneryModel();
    // 40 tight sightings inside twenty minutes.
    const t = soak(model, [det("person", PHANTOM)], 41);
    assert.equal(model.isScenery(CAM, det("person", PHANTOM), t), false);
  });

  it("still exempts animals", () => {
    const model = new SceneryModel();
    let t = 1_000_000;
    for (let i = 0; i < 151; i++) {
      model.observe(CAM, i % 12 < 5 ? [det("cat", PHANTOM, 0.6)] : [], t);
      t += SWEEP;
    }
    assert.equal(model.isScenery(CAM, det("cat", PHANTOM, 0.6), t), false);
  });
});
