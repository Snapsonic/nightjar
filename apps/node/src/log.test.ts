import assert from "node:assert/strict";
import { test } from "node:test";
import { stamp } from "./log.js";

test("stamp renders local time, not UTC, with a sortable shape", () => {
  const at = new Date("2026-07-28T04:22:51.560Z");
  const out = stamp(at);
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  // The hour must be the local hour for the host TZ, which is the whole point:
  // reading these next to a wall clock should need no arithmetic.
  assert.equal(out.slice(11, 13), String(at.getHours()).padStart(2, "0"));
});

test("stamp keeps the UTC offset so a line stays unambiguous", () => {
  const out = stamp(new Date("2026-07-28T04:22:51.560Z"));
  const offsetMin = -new Date("2026-07-28T04:22:51.560Z").getTimezoneOffset();
  const sign = offsetMin < 0 ? "-" : "+";
  const hh = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0");
  assert.ok(out.endsWith(`${sign}${hh}:${String(Math.abs(offsetMin) % 60).padStart(2, "0")}`));
});
