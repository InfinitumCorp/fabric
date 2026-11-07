import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { theme } from "./theme.ts";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.name === "node_modules" ? [] : d.isDirectory() ? files(join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [join(dir, d.name)] : []);
}

test("the base64 scaffold is never imported", () => {
  const offenders = files(join(import.meta.dirname, "..")).filter((f) => readFileSync(f, "utf8").includes(["@infinitum", "fabric"].join("/")));
  assert.deepEqual(offenders, []);
});

test("brand tokens match the spec", () => {
  assert.deepEqual(
    [theme.paper, theme.ink, theme.muted, theme.line, theme.accent, theme.name],
    ["#ffffff", "#111820", "#52606b", "#d6dce1", "#2454dd", "FabriC++"],
  );
});

test("no payment or organisation secrets are embedded in source", () => {
  const pattern = new RegExp(["sk_(live|test)_", "rk_(live|test)_", "whsec_", "STRIPE_SECRET"].join("|"));
  const offenders = files(join(import.meta.dirname, "..")).filter((f) => !f.endsWith(".test.ts") && pattern.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});
