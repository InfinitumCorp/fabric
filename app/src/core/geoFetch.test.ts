import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GeoChecksumError,
  defaultLockPath,
  fetchGeoDatasets,
  isDirectRun,
  loadLock,
  parseSha256Sum,
  releaseUrl,
} from "./geoFetch.ts";
import { defaultGeoDir } from "./geo.ts";

const VERIFIED = {
  geoip: {
    tag: "202611080027",
    sha256: "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2",
    sum: "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2  geoip.dat\n",
  },
  geosite: {
    tag: "20261108011013",
    sha256: "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2",
    sum: "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2  dlc.dat\n",
  },
};

test("lockfile pins the verified v2fly release assets", () => {
  const lock = loadLock(readFileSync(defaultLockPath(), "utf8"));
  assert.equal(lock.datasets[0].tag, VERIFIED.geoip.tag);
  assert.equal(lock.datasets[0].sha256, VERIFIED.geoip.sha256);
  assert.equal(lock.datasets[0].url, releaseUrl("v2fly/geoip", VERIFIED.geoip.tag, "geoip.dat"));
  assert.equal(lock.datasets[1].tag, VERIFIED.geosite.tag);
  assert.equal(lock.datasets[1].sha256, VERIFIED.geosite.sha256);
  assert.equal(lock.datasets[1].filename, "geosite.dat");
  assert.equal(lock.datasets[1].upstreamAsset, "dlc.dat");
  assert.equal(lock.datasets[1].url, releaseUrl("v2fly/domain-list-community", VERIFIED.geosite.tag, "dlc.dat"));
  assert.deepEqual(parseSha256Sum(VERIFIED.geoip.sum), { sha256: VERIFIED.geoip.sha256, name: "geoip.dat" });
  assert.deepEqual(parseSha256Sum(VERIFIED.geosite.sum), { sha256: VERIFIED.geosite.sha256, name: "dlc.dat" });
  assert.equal(defaultGeoDir().endsWith(`${path.sep}data${path.sep}geo`), true);
  const gitignore = readFileSync(new URL("../../../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /^app\/data\/$/m);
  assert.equal(isDirectRun("/tmp/other.ts", "file:///tmp/geoFetch.ts"), false);
});

test("lockfile rejects datasets outside the two v2fly releases", () => {
  const raw = JSON.parse(readFileSync(defaultLockPath(), "utf8"));
  raw.datasets[0].url = "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202611080027/geoip.dat";
  assert.throws(() => loadLock(JSON.stringify(raw)), /v2fly release asset/);
  raw.datasets[0].url = releaseUrl("v2fly/geoip", VERIFIED.geoip.tag, "geoip.dat");
  raw.datasets[1].url = "https://github.com/SagerNet/sing-geoip/releases/download/20261108011013/dlc.dat";
  assert.throws(() => loadLock(JSON.stringify(raw)), /v2fly release asset/);
  raw.datasets[1].url = releaseUrl("v2fly/domain-list-community", VERIFIED.geosite.tag, "dlc.dat");
  raw.datasets[1].sha256 = VERIFIED.geosite.sha256.toUpperCase();
  assert.throws(() => loadLock(JSON.stringify(raw)), /sha256/);
});

test("fetch writes geosite.dat only when both checksums match", async () => {
  const dest = await mkdtemp(path.join(os.tmpdir(), "fabric-geo-"));
  try {
    const geoip = Buffer.from("geoip-bytes");
    const geosite = Buffer.from("geosite-bytes");
    const { lock, files } = pinned(geoip, geosite);
    const lockPath = path.join(dest, "geo.lock.json");
    await writeFile(lockPath, JSON.stringify(lock));
    const calls: string[] = [];
    const written = await fetchGeoDatasets({
      lockPath,
      destDir: dest,
      fetchImpl: fake(files, calls),
    });
    assert.deepEqual(written.map((file) => file.filename), ["geoip.dat", "geosite.dat"]);
    assert.equal(readFileSync(path.join(dest, "geoip.dat")).equals(geoip), true);
    assert.equal(readFileSync(path.join(dest, "geosite.dat")).equals(geosite), true);
    assert.equal(existsSync(path.join(dest, "dlc.dat")), false);
    assert.equal(existsSync(path.join(dest, ".geoip.dat.partial")), false);
    assert.equal(calls.length, 4);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("fetch stops when the official sha256sum disagrees with the lockfile", async () => {
  const dest = await mkdtemp(path.join(os.tmpdir(), "fabric-geo-"));
  try {
    const geoip = Buffer.from("geoip-bytes");
    const geosite = Buffer.from("geosite-bytes");
    const { lock, files } = pinned(geoip, geosite);
    files[lock.datasets[0].sha256sumUrl] = Buffer.from(`${"a".repeat(64)}  geoip.dat\n`);
    const lockPath = path.join(dest, "geo.lock.json");
    await writeFile(lockPath, JSON.stringify(lock));
    const calls: string[] = [];
    await assert.rejects(
      () => fetchGeoDatasets({ lockPath, destDir: dest, fetchImpl: fake(files, calls) }),
      (err: unknown) => {
        assert.ok(err instanceof GeoChecksumError);
        assert.match(err.message, /official sha256sum does not match the lockfile/);
        assert.match(err.message, new RegExp(lock.datasets[0].sha256));
        assert.match(err.message, new RegExp("a".repeat(64)));
        return true;
      },
    );
    assert.equal(calls.includes(lock.datasets[0].url), false);
    assert.equal(existsSync(path.join(dest, "geoip.dat")), false);
    assert.equal(existsSync(path.join(dest, "geosite.dat")), false);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("fetch deletes a partial file when the bytes disagree", async () => {
  const dest = await mkdtemp(path.join(os.tmpdir(), "fabric-geo-"));
  try {
    const geoip = Buffer.from("geoip-bytes");
    const geosite = Buffer.from("geosite-bytes");
    const { lock, files } = pinned(geoip, geosite);
    files[lock.datasets[1].url] = Buffer.from("tampered");
    const lockPath = path.join(dest, "geo.lock.json");
    await writeFile(lockPath, JSON.stringify(lock));
    await writeFile(path.join(dest, ".geosite.dat.partial"), Buffer.from("stale"));
    await assert.rejects(
      () => fetchGeoDatasets({ lockPath, destDir: dest, fetchImpl: fake(files, []) }),
      (err: unknown) => {
        assert.ok(err instanceof GeoChecksumError);
        assert.match(err.message, /downloaded bytes do not match/);
        assert.match(err.message, /computed:/);
        return true;
      },
    );
    assert.equal(existsSync(path.join(dest, "geoip.dat")), true);
    assert.equal(existsSync(path.join(dest, "geosite.dat")), false);
    assert.equal(existsSync(path.join(dest, ".geosite.dat.partial")), false);
    assert.equal(createHash("sha256").update(await readFile(path.join(dest, "geoip.dat"))).digest("hex"), lock.datasets[0].sha256);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function pinned(geoip: Buffer, geosite: Buffer) {
  const specs = [
    {
      id: "geoip",
      filename: "geoip.dat",
      upstreamAsset: "geoip.dat",
      tag: "20260101010101",
      license: "CC-BY-SA-4.0",
      repo: "v2fly/geoip",
      source: "https://github.com/v2fly/geoip",
      body: geoip,
    },
    {
      id: "geosite",
      filename: "geosite.dat",
      upstreamAsset: "dlc.dat",
      tag: "20260101010102",
      license: "MIT",
      repo: "v2fly/domain-list-community",
      source: "https://github.com/v2fly/domain-list-community",
      body: geosite,
    },
  ] as const;
  const files: Record<string, Buffer> = {};
  const datasets = specs.map((spec) => {
    const digest = sha(spec.body);
    const url = releaseUrl(spec.repo, spec.tag, spec.upstreamAsset);
    const sha256sumUrl = `${url}.sha256sum`;
    files[url] = spec.body;
    files[sha256sumUrl] = Buffer.from(`${digest}  ${spec.upstreamAsset}\n`);
    return {
      id: spec.id,
      filename: spec.filename,
      upstreamAsset: spec.upstreamAsset,
      tag: spec.tag,
      license: spec.license,
      url,
      sha256: digest,
      sha256sumUrl,
      source: spec.source,
    };
  });
  return { lock: { version: 1, datasets }, files };
}

function fake(files: Record<string, Buffer>, calls: string[]): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    const body = files[url];
    if (!body) return new Response("missing", { status: 404 });
    return new Response(body);
  }) as typeof fetch;
}
