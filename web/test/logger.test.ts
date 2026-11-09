import { test } from "node:test";
import assert from "node:assert/strict";
import { createRedactingLogger, redactLine } from "../src/logger.ts";

test("log lines drop passwords, tokens, and message bodies", () => {
  const line = redactLine(
    'login @alice:localhost "password":"s3cret" access_token":"syt_abc" body":"meet at 9" Bearer xyz.987',
  );
  assert.equal(line.includes("alice"), false);
  assert.equal(line.includes("s3cret"), false);
  assert.equal(line.includes("syt_abc"), false);
  assert.equal(line.includes("meet at 9"), false);
  assert.equal(line.includes("xyz.987"), false);
});

test("the sdk logger records only redacted warnings and errors", () => {
  const lines: string[] = [];
  const logger = createRedactingLogger((level, line) => lines.push(`${level}:${line}`));
  logger.debug("password=s3cret");
  logger.info("body=hello");
  logger.trace("syt_abc");
  logger.warn('token "access_token":"syt_should_hide"');
  logger.error("Bearer real.token");
  logger.getChild("crypto").error('{"password":"again"}');
  assert.equal(lines.some((l) => l.includes("s3cret") || l.includes("hello") || l.includes("syt_abc")), false);
  assert.equal(lines.some((l) => l.startsWith("warn:")), true);
  assert.equal(lines.some((l) => l.includes("syt_should_hide") || l.includes("again") || l.includes("real.token")), false);
});
