import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./redact.ts";
import {
  annotateLine,
  defaultGeoDir,
  geoEnabled,
  loadGeoBytes,
  lookupGeo,
  resetGeoCache,
} from "./geo.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const geoipFixture = readFileSync(path.join(here, "testdata/geoip.dat"));
const geositeFixture = readFileSync(path.join(here, "testdata/geosite.dat"));

const GEOIP_HEX =
  "0a0e0a02555312080a040102030010180a0e0a02434112080a040102000010100a1b0a03444f4312140a1020010db800000000000000000000000010200a1b0a0353554212140a1020010db800010000000000000000000010300a100a024e4f12080a040000000010001801";
const GEOSITE_HEX =
  "0a230a03414453120f0803120b6164732e6578616d706c65120b08001207747261636b65720a170a044e455753120f0802120b6578616d706c652e636f6d0a1c0a0252581216080112125e666f6f2d5b302d395d2b5c2e7465737424";

function varint(n: number): Buffer {
  const out: number[] = [];
  let value = n;
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return Buffer.from(out);
}

function bytesField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(payload.length), payload]);
}

function varField(field: number, n: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(n)]);
}

function strField(field: number, value: string): Buffer {
  return bytesField(field, Buffer.from(value));
}

function cidr(ip: Buffer, prefix: number): Buffer {
  return Buffer.concat([bytesField(1, ip), varField(2, prefix)]);
}

function geoip(code: string, cidrs: Buffer[], inverse = false): Buffer {
  const parts = [strField(1, code), ...cidrs.map((item) => bytesField(2, item))];
  if (inverse) parts.push(varField(3, 1));
  return Buffer.concat(parts);
}

test("synthetic fixtures are the pinned protobuf bytes", () => {
  assert.equal(geoipFixture.toString("hex"), GEOIP_HEX);
  assert.equal(geositeFixture.toString("hex"), GEOSITE_HEX);
  const us = geoip("US", [cidr(Buffer.from([1, 2, 3, 0]), 24)]);
  assert.equal(bytesField(1, us).toString("hex"), GEOIP_HEX.slice(0, 32));
});

test("ip lookup uses the longest prefix and skips inverse lists", () => {
  const geo = loadGeoBytes(geoipFixture, geositeFixture);
  assert.equal(geo.countryForIp("1.2.3.4"), "US");
  assert.equal(geo.countryForIp("1.2.3.0"), "US");
  assert.equal(geo.countryForIp("1.2.9.9"), "CA");
  assert.equal(geo.countryForIp("1.3.0.1"), null);
  assert.equal(geo.countryForIp("9.9.9.9"), null);
  assert.equal(geo.countryForIp("::ffff:1.2.3.4"), "US");
  assert.equal(geo.countryForIp("2001:db8:1::1"), "SUB");
  assert.equal(geo.countryForIp("2001:DB8::1"), "DOC");
  assert.equal(geo.countryForIp("::1"), null);
  assert.equal(geo.countryForIp("1.2.3.256"), null);
  assert.equal(geo.countryForIp("not-an-ip"), null);
});

test("domain lookup follows full, root, plain, and regex rules", () => {
  const geo = loadGeoBytes(geoipFixture, geositeFixture);
  assert.deepEqual(geo.categoriesForDomain("ads.example"), ["ADS"]);
  assert.deepEqual(geo.categoriesForDomain("Ads.Example."), ["ADS"]);
  assert.deepEqual(geo.categoriesForDomain("www.ads.example"), []);
  assert.deepEqual(geo.categoriesForDomain("a.example.com"), ["NEWS"]);
  assert.deepEqual(geo.categoriesForDomain("example.com"), ["NEWS"]);
  assert.deepEqual(geo.categoriesForDomain("notexample.com"), []);
  assert.deepEqual(geo.categoriesForDomain("my.tracker.example.com"), ["NEWS", "ADS"]);
  assert.deepEqual(geo.categoriesForDomain("foo-12.test"), ["RX"]);
  assert.deepEqual(geo.categoriesForDomain("Foo-12.TEST"), ["RX"]);
  assert.deepEqual(geo.categoriesForDomain("foo-12.test.evil"), []);
  assert.deepEqual(geo.categoriesForDomain("foo-x.test"), []);
});

test("loader masks host bits, keeps the first equal prefix, and skips bad records", () => {
  const list = Buffer.concat([
    bytesField(1, geoip("AA", [cidr(Buffer.from([9, 9, 9, 9]), 32)])),
    bytesField(1, geoip("BB", [cidr(Buffer.from([9, 9, 9, 9]), 32)])),
    bytesField(1, geoip("CC", [cidr(Buffer.from([1, 2, 3, 9]), 24), cidr(Buffer.from([8, 8, 8, 8]), 40), cidr(Buffer.from([8, 8, 8, 8]), 32)])),
  ]);
  const geo = loadGeoBytes(list, Buffer.alloc(0));
  assert.equal(geo.countryForIp("9.9.9.9"), "AA");
  assert.equal(geo.countryForIp("1.2.3.8"), "CC");
  assert.equal(geo.countryForIp("8.8.8.8"), "CC");
});

test("domain attributes and a bad regex do not hide valid rules", () => {
  const attr = Buffer.concat([strField(1, "cn"), varField(2, 1)]);
  const domain = Buffer.concat([varField(1, 3), strField(2, "ads.example"), bytesField(3, attr)]);
  const broken = Buffer.concat([varField(1, 1), strField(2, "(")]);
  const ok = Buffer.concat([varField(1, 3), strField(2, "ok.test")]);
  const site = Buffer.concat([
    bytesField(1, Buffer.concat([strField(1, "ADS"), bytesField(2, domain)])),
    bytesField(1, Buffer.concat([strField(1, "OK"), bytesField(2, broken), bytesField(2, ok)])),
  ]);
  const geo = loadGeoBytes(Buffer.alloc(0), site);
  assert.deepEqual(geo.categoriesForDomain("ads.example"), ["ADS"]);
  assert.deepEqual(geo.categoriesForDomain("ok.test"), ["OK"]);
});

test("truncated protobuf is rejected", () => {
  assert.throws(() => loadGeoBytes(Buffer.from([0x0a, 0x05, 0x01]), Buffer.alloc(0)), /truncated geo protobuf/);
});

test("geo flag defaults off and annotation is opt-in", () => {
  resetGeoCache();
  assert.equal(geoEnabled({}), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "0" }), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "false" }), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "" }), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "1" }), true);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "true" }), true);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "TRUE" }), true);
  assert.equal(defaultGeoDir().endsWith(`${path.sep}app${path.sep}data${path.sep}geo`), true);

  const fixtureDir = path.join(here, "testdata");
  const off = { INFINITUM_GEO_ENABLED: "0", INFINITUM_GEO_DIR: fixtureDir };
  const on = { INFINITUM_GEO_ENABLED: "1", INFINITUM_GEO_DIR: fixtureDir };
  const line = "connect 1.2.3.4 host=ads.example v6=2001:db8:1::1 name=a.example.com";
  assert.equal(annotateLine(line, off), line);
  assert.equal(lookupGeo({ ip: "1.2.3.4", domain: "ads.example" }, off), null);
  assert.equal(
    annotateLine(line, on),
    `${line} geoip=US,SUB geosite=ADS,NEWS`,
  );
  assert.deepEqual(lookupGeo({ ip: "1.2.3.4", domain: "ads.example" }, on), {
    country: "US",
    categories: ["ADS"],
  });

  const redacted = redact(
    'send @alice:fabric.localhost token=syt_abc123 Bearer xyz.987 body="meet at 9" host=ads.example ip=1.2.3.4',
    on,
  );
  assert.equal(redacted.includes("alice"), false);
  assert.equal(redacted.includes("syt_abc123"), false);
  assert.equal(redacted.includes("xyz.987"), false);
  assert.equal(redacted.includes("meet at 9"), false);
  assert.match(redacted, /\[user\]/);
  assert.match(redacted, /geoip=US/);
  assert.match(redacted, /geosite=ADS/);

  const unchanged = redact("connect 1.2.3.4 host=ads.example", off);
  assert.equal(unchanged, "connect 1.2.3.4 host=ads.example");
  assert.equal(annotateLine("connect 1.2.3.4", { INFINITUM_GEO_ENABLED: "1", INFINITUM_GEO_DIR: path.join(here, "missing-geo") }), "connect 1.2.3.4");
});
