import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact.ts";

test("redacts user ids, tokens and bodies", () => {
  const out = redact('send @alice:fabric.localhost token=syt_abc123 Bearer xyz.987 body="meet at 9"');
  assert.ok(!out.includes("alice"));
  assert.ok(!out.includes("syt_abc123"));
  assert.ok(!out.includes("xyz.987"));
  assert.ok(!out.includes("meet at 9"));
  assert.match(out, /\[user\]/);
});
