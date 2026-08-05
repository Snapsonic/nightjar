import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CameraConfig, inQuietWindow, QuietWindow, RealtimeMessage } from "@nightjar/shared";

const at = (hhmm: string): Date => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(2026, 7, 5, h ?? 0, m ?? 0, 0);
  return d;
};
const win = (kinds: string[], start: string, end: string) =>
  QuietWindow.parse({ kinds, start, end });

describe("inQuietWindow", () => {
  const afternoon = [win(["cat"], "10:00", "18:00")];

  it("silences the listed kind inside the window", () => {
    assert.equal(inQuietWindow(afternoon, "cat", at("10:00")), true); // start inclusive
    assert.equal(inQuietWindow(afternoon, "cat", at("14:30")), true);
    assert.equal(inQuietWindow(afternoon, "cat", at("17:59")), true);
  });

  it("leaves the edges and the rest of the day alone", () => {
    assert.equal(inQuietWindow(afternoon, "cat", at("09:59")), false);
    assert.equal(inQuietWindow(afternoon, "cat", at("18:00")), false); // end exclusive
    assert.equal(inQuietWindow(afternoon, "cat", at("23:00")), false);
  });

  it("never silences a kind the window does not list", () => {
    // The whole point: quieting the cat must not quiet the person who walks
    // past the same camera at the same time.
    assert.equal(inQuietWindow(afternoon, "person", at("14:30")), false);
    assert.equal(inQuietWindow(afternoon, "dog", at("14:30")), false);
  });

  it("wraps midnight when start is after end", () => {
    const overnight = [win(["vehicle"], "22:00", "06:00")];
    assert.equal(inQuietWindow(overnight, "vehicle", at("22:00")), true);
    assert.equal(inQuietWindow(overnight, "vehicle", at("23:59")), true);
    assert.equal(inQuietWindow(overnight, "vehicle", at("00:00")), true);
    assert.equal(inQuietWindow(overnight, "vehicle", at("05:59")), true);
    assert.equal(inQuietWindow(overnight, "vehicle", at("06:00")), false);
    assert.equal(inQuietWindow(overnight, "vehicle", at("12:00")), false);
  });

  it("treats a zero-length window as off, not as all day", () => {
    // An easy way to silence a camera by accident, so it is spelled out.
    const empty = [win(["person"], "09:00", "09:00")];
    assert.equal(inQuietWindow(empty, "person", at("09:00")), false);
    assert.equal(inQuietWindow(empty, "person", at("21:00")), false);
  });

  it("no windows means always on", () => {
    assert.equal(inQuietWindow([], "cat", at("14:30")), false);
  });

  it("honours whichever of several windows matches", () => {
    const many = [win(["cat"], "10:00", "18:00"), win(["person", "vehicle"], "01:00", "05:00")];
    assert.equal(inQuietWindow(many, "cat", at("11:00")), true);
    assert.equal(inQuietWindow(many, "person", at("11:00")), false);
    assert.equal(inQuietWindow(many, "person", at("02:00")), true);
    assert.equal(inQuietWindow(many, "vehicle", at("02:00")), true);
    assert.equal(inQuietWindow(many, "cat", at("02:00")), false);
  });

  it("rejects malformed times at the schema boundary", () => {
    assert.ok(!QuietWindow.safeParse({ kinds: ["cat"], start: "24:00", end: "18:00" }).success);
    assert.ok(!QuietWindow.safeParse({ kinds: ["cat"], start: "9:00", end: "18:00" }).success);
    assert.ok(!QuietWindow.safeParse({ kinds: [], start: "10:00", end: "18:00" }).success);
  });
});

describe("update_quiet_hours protocol", () => {
  it("round-trips through the realtime union", () => {
    const message = {
      type: "update_quiet_hours_request",
      requestId: "r1",
      cameraId: "7c0939a2-275a-4d1e-a7ba-70371fbe98a5",
      quietHours: [{ kinds: ["cat", "dog"], start: "10:00", end: "18:00" }],
    };
    const parsed = RealtimeMessage.parse(JSON.parse(JSON.stringify(message)));
    assert.equal(parsed.type, "update_quiet_hours_request");
    assert.deepEqual(
      RealtimeMessage.parse({ type: "update_quiet_hours_reply", requestId: "r1", ok: true }).type,
      "update_quiet_hours_reply",
    );
  });

  it("rejects a window with an impossible time", () => {
    assert.ok(
      !RealtimeMessage.safeParse({
        type: "update_quiet_hours_request",
        requestId: "r1",
        cameraId: "7c0939a2-275a-4d1e-a7ba-70371fbe98a5",
        quietHours: [{ kinds: ["cat"], start: "25:00", end: "18:00" }],
      }).success,
    );
  });

  it("a camera config with no quietHours parses to always-on", () => {
    const camera = CameraConfig.parse({
      id: "7c0939a2-275a-4d1e-a7ba-70371fbe98a5",
      name: "Backyard",
      source: "nest",
      nest: { deviceId: "enterprises/p/devices/d" },
    });
    assert.deepEqual(camera.quietHours, []);
    assert.equal(inQuietWindow(camera.quietHours, "cat", new Date()), false);
  });
});
