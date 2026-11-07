import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === ".local") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|css|html)$/.test(name) ? [path] : [];
  });
}

test("browser source does not persist secrets or load remote scripts", () => {
  const root = new URL("..", import.meta.url).pathname;
  const paths = [...files(join(root, "src")), join(root, "index.html"), join(root, "vite.config.ts")];
  const blob = paths.map((p) => readFileSync(p, "utf8")).join("\n");
  assert.match(blob, /useIndexedDB:\s*false/);
  assert.equal(blob.includes("useIndexedDB: true"), false);
  assert.equal(blob.includes("setupNewCrossSigning: true"), false);
  assert.equal(blob.includes("resetEncryption"), false);
  assert.equal(blob.includes("dangerouslySetInnerHTML"), false);
  assert.equal(blob.includes("beforeunload"), false);
  assert.equal(blob.includes("pagehide"), false);
  assert.equal(/\blocalStorage\b|\bsessionStorage\b/.test(blob), false);
  assert.equal(/\bindexedDB\b/.test(blob), false);
  assert.equal(/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(blob), false);
  assert.equal(/googletagmanager|google-analytics|cdn\.|unpkg|jsdelivr/i.test(blob), false);
});
