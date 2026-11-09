import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  ChecksumMismatch,
  assertChecksum,
  assertV2flyUrl,
  installVerified,
  loadLock,
  parseSha256Sum,
  repoRoot,
  sha256Hex,
  type GeoDatasetSpec,
} from "./fetchGeo.ts";
import { parseGeoArgs } from "./geo-cli.ts";
import {
  DomainKind,
  decodeGeoIp,
  decodeGeoSite,
  encodeGeoIp,
  encodeGeoSite,
  loadGeoLists,
  syntheticGeoIp,
  syntheticGeoSite,
} from "./geoDat.ts";
import { annotateRedactedLog, evaluateSendPolicy, geoFeatureEnabled, openGeoGate } from "./geoHook.ts";
import { loadSettings, saveSettings } from "./geoSettings.ts";
import { redact } from "./redact.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "fixtures");

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest > 127) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

function lenField(field: number, data: number[]): number[] {
  return varint(field * 8 + 2).concat(varint(data.length), data);
}

function varintField(field: number, value: number): number[] {
  return varint(field * 8).concat(varint(value));
}

test("handcrafted protobuf maps an address to a country and a domain to a category", () => {
  const cidr = lenField(1, [1, 2, 3, 0]).concat(varintField(2, 24));
  const geoip = lenField(1, [0x55, 0x53]).concat(lenField(2, cidr));
  const lists = loadGeoLists(Uint8Array.from(lenField(1, geoip)), Uint8Array.from([]));
  assert.equal(lists.countryOf("1.2.3.4"), "US");
  assert.equal(lists.countryOf("1.2.4.4"), null);

  const domain = varintField(1, DomainKind.Domain).concat(lenField(2, [...Buffer.from("example.com")]));
  const site = lenField(1, [...Buffer.from("example")]).concat(lenField(2, domain));
  const sites = loadGeoLists(Uint8Array.from([]), Uint8Array.from(lenField(1, site)));
  assert.deepEqual(sites.categoriesOf("a.example.com"), ["example"]);
  assert.deepEqual(sites.categoriesOf("notexample.com"), []);
});

test("synthetic dat fixtures resolve country and category", () => {
  const geoip = readFileSync(path.join(fixtureDir, "synthetic-geoip.dat"));
  const geosite = readFileSync(path.join(fixtureDir, "synthetic-geosite.dat"));
  assert.deepEqual(geoip, Buffer.from(encodeGeoIp(syntheticGeoIp())));
  assert.deepEqual(geosite, Buffer.from(encodeGeoSite(syntheticGeoSite())));
  const lists = loadGeoLists(geoip, geosite);
  assert.equal(lists.countryOf("1.2.3.4"), "US");
  assert.equal(lists.countryOf("1.2.3.255"), "US");
  assert.equal(lists.countryOf("1.2.4.0"), null);
  assert.equal(lists.countryOf("198.51.100.9"), "US");
  assert.equal(lists.countryOf("198.51.100.10"), "DE");
  assert.equal(lists.countryOf("198.51.100.200"), "FR");
  assert.equal(lists.countryOf("203.0.113.10"), "DE");
  assert.equal(lists.countryOf("203.0.113.11"), null);
  assert.equal(lists.countryOf("2001:db8::1"), "SE");
  assert.equal(lists.countryOf("[2001:db8::1]"), "SE");
  assert.equal(lists.countryOf("2001:db9::1"), null);
  assert.equal(lists.countryOf("10.9.8.7"), null);
  assert.deepEqual(lists.matches("10.9.8.7"), ["PRIVATE", "ZZ"]);
  assert.deepEqual(lists.matches("9.9.9.9"), []);
  assert.deepEqual(lists.matches("192.0.2.5"), ["ZZ"]);
  assert.equal(lists.countryOf("192.0.2.5"), null);
  assert.deepEqual(lists.categoriesOf("Example.COM"), ["example"]);
  assert.deepEqual(lists.categoriesOf("a.example.com"), ["example"]);
  assert.deepEqual(lists.categoriesOf("notexample.com"), []);
  assert.deepEqual(lists.categoriesOf("news.example"), ["news"]);
  assert.deepEqual(lists.categoriesOf("www.news.example"), []);
  assert.deepEqual(lists.categoriesOf("mykeyword.test"), ["plain"]);
  assert.deepEqual(lists.categoriesOf("only.fabric.test"), ["chat"]);
  assert.deepEqual(lists.categoriesOf("sub.only.fabric.test"), []);
  assert.deepEqual(lists.categoriesOf("https://example.com/path"), []);
  assert.throws(() => decodeGeoIp(Uint8Array.from([0x0a, 0x05, 0x0a])));
  assert.throws(() => decodeGeoSite(Uint8Array.from([0x0a, 0x05])));
});

test("geo hook stays off unless opted in and never changes the send decision", () => {
  const lists = loadGeoLists(encodeGeoIp(syntheticGeoIp()), encodeGeoSite(syntheticGeoSite()));
  const room = { encryption: "on" as const, pendingIdentityChange: false };
  const blocked = { encryption: "off" as const, pendingIdentityChange: false };
  const peer = { ip: "1.2.3.4", domain: "a.example.com" };
  const line = 'send @alice:fabric.localhost token=syt_abc123 body="meet at 9"';

  assert.equal(geoFeatureEnabled(undefined, false), false);
  assert.equal(geoFeatureEnabled("", false), false);
  assert.equal(geoFeatureEnabled("0", true), false);
  assert.equal(geoFeatureEnabled("maybe", true), false);
  assert.equal(geoFeatureEnabled(undefined, true), true);
  assert.equal(geoFeatureEnabled("on", false), true);

  const off = openGeoGate(undefined, false, lists);
  assert.equal(off.enabled, false);
  assert.deepEqual(evaluateSendPolicy(room, peer, off), { decision: { ok: true }, geo: null });
  assert.deepEqual(evaluateSendPolicy(blocked, peer, off), { decision: { ok: false, reason: "not_encrypted" }, geo: null });
  assert.equal(annotateRedactedLog(line, peer, off), redact(line));

  const on = openGeoGate("on", false, lists);
  const allowed = evaluateSendPolicy(room, peer, on);
  const refused = evaluateSendPolicy(blocked, peer, on);
  assert.deepEqual(allowed.decision, { ok: true });
  assert.deepEqual(refused.decision, { ok: false, reason: "not_encrypted" });
  assert.deepEqual(allowed.geo, { country: "US", categories: ["example"] });
  const annotated = annotateRedactedLog(line, peer, on);
  assert.equal(annotated.includes("meet at 9"), false);
  assert.equal(annotated.includes("syt_abc123"), false);
  assert.equal(annotated.includes("alice"), false);
  assert.match(annotated, /geo_country=US/);
  assert.match(annotated, /geo_categories=example/);
  assert.equal(annotated.startsWith(redact(line)), true);
});

test("settings default off and persist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fabric-geo-"));
  const file = path.join(dir, "fabric.settings.json");
  try {
    assert.deepEqual(loadSettings(file), { geoRouting: false });
    assert.equal(loadSettings(path.join(repoRoot(), "app", "fabric.settings.json")).geoRouting, false);
    saveSettings(file, { geoRouting: true });
    assert.equal(loadSettings(file).geoRouting, true);
    saveSettings(file, { geoRouting: false });
    assert.equal(loadSettings(file).geoRouting, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lockfile pins the v2fly releases and rejects other sources", () => {
  const lock = loadLock(path.join(repoRoot(), "geo", "geo.lock.json"));
  assert.equal(lock.source, "v2fly");
  assert.equal(lock.datasets[0].tag, "202611080027");
  assert.equal(lock.datasets[0].filename, "geoip.dat");
  assert.equal(lock.datasets[0].sha256, "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2");
  assert.equal(lock.datasets[0].license, "CC-BY-SA-4.0");
  assert.equal(lock.datasets[1].tag, "20261108011013");
  assert.equal(lock.datasets[1].filename, "geosite.dat");
  assert.equal(lock.datasets[1].upstreamFilename, "dlc.dat");
  assert.equal(lock.datasets[1].sha256, "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2");
  assert.equal(lock.datasets[1].license, "MIT");
  assert.throws(() => assertV2flyUrl("https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/x/geoip.dat", "geoip"));
  assert.throws(() => assertV2flyUrl("https://github.com/SagerNet/sing-box/releases/download/x/geoip.dat", "geoip"));
  assert.equal(parseSha256Sum(`${lock.datasets[1].sha256}  dlc.dat\n`, "dlc.dat"), lock.datasets[1].sha256);
});

test("install fails closed on checksum mismatch and writes geosite.dat after a match", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fabric-geo-dat-"));
  const spec: GeoDatasetSpec = {
    id: "geosite",
    filename: "geosite.dat",
    upstreamFilename: "dlc.dat",
    url: "https://github.com/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat",
    sha256Url: "https://github.com/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat.sha256sum",
    tag: "20261108011013",
    repository: "https://github.com/v2fly/domain-list-community",
    sha256: "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2",
    license: "MIT",
  };
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const official = `${spec.sha256}  dlc.dat\n`;
  try {
    assert.throws(() => installVerified(spec, bytes, official, dir), ChecksumMismatch);
    assert.deepEqual(readdirSync(dir), []);
    const matching = { ...spec, sha256: sha256Hex(bytes) };
    const text = `${matching.sha256}  dlc.dat\n`;
    assertChecksum(bytes, text, matching);
    const saved = installVerified(matching, bytes, text, dir);
    assert.equal(path.basename(saved), "geosite.dat");
    assert.deepEqual(readFileSync(saved), Buffer.from(bytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli flag persists geo routing and defaults to off", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fabric-geo-cli-"));
  const settings = path.join(dir, "fabric.settings.json");
  const cli = path.join(here, "geo-cli.ts");
  try {
    const status = spawnSync(process.execPath, ["--experimental-strip-types", cli, "--geo-routing", "status", "--settings", settings], {
      encoding: "utf8",
    });
    assert.equal(status.status, 0);
    assert.equal(status.stdout.trim(), "off");
    const enabled = spawnSync(process.execPath, ["--experimental-strip-types", cli, "--geo-routing", "on", "--settings", settings], {
      encoding: "utf8",
    });
    assert.equal(enabled.status, 0);
    assert.equal(loadSettings(settings).geoRouting, true);
    const disabled = spawnSync(process.execPath, ["--experimental-strip-types", cli, "--geo-routing", "off", "--settings", settings], {
      encoding: "utf8",
    });
    assert.equal(disabled.status, 0);
    assert.equal(loadSettings(settings).geoRouting, false);
    assert.deepEqual(parseGeoArgs(["node", "geo-cli.ts", "fetch"]).action, "fetch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
