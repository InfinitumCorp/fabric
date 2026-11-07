import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageCounter } from "./usage.ts";

test("nothing is counted or released without consent", () => {
  const u = new UsageCounter(() => false);
  u.onSent(); u.onReceived(); u.addSession(30);
  assert.equal(u.flush("2026-11-07"), null);
});

test("counts are numbers and a date only", () => {
  let consented = true;
  const u = new UsageCounter(() => consented);
  u.onSent(); u.onSent(); u.onReceived(); u.addSession(42);
  const d = u.flush("2026-11-07");
  assert.deepEqual(d, { date: "2026-11-07", sent: 2, received: 1, sessionSeconds: 42 });
  assert.deepEqual(Object.keys(d!).sort(), ["date", "received", "sent", "sessionSeconds"]);
  assert.equal(u.flush("2026-11-08"), null);

  u.onSent();
  consented = false;
  assert.equal(u.flush("2026-11-08"), null);
});
