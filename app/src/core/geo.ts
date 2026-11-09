// v2fly GeoIPList / GeoSiteList loader (protobuf, no extra dependencies).
// Dataset bytes are downloaded, not committed. See THIRD_PARTY_NOTICES and app/geo.lock.json.
// INFINITUM_GEO_ENABLED defaults off; logging stays unchanged until it is set.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type GeoEnv = {
  INFINITUM_GEO_ENABLED?: string;
  INFINITUM_GEO_DIR?: string;
};

export type GeoData = {
  countryForIp(ip: string): string | null;
  categoriesForDomain(domain: string): string[];
};

export type GeoNote = {
  country: string | null;
  categories: string[];
};

type Reader = { buf: Uint8Array; pos: number };
type Cidr = { ip: Uint8Array; prefix: number };
type DomainRule = { type: number; value: string };

const CODE_OK = /^[A-Za-z0-9!_.+-]{1,64}$/;

export function defaultGeoDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../data/geo");
}

export function geoEnabled(env: GeoEnv = process.env): boolean {
  const value = env.INFINITUM_GEO_ENABLED;
  if (value === undefined) return false;
  return value.toLowerCase() === "1" || value.toLowerCase() === "true";
}

export function loadGeoBytes(geoip: Uint8Array, geosite: Uint8Array): GeoData {
  const ipIndex = buildIpIndex(parseGeoIps(geoip));
  const siteIndex = buildSiteIndex(parseGeoSites(geosite));
  return {
    countryForIp(ip: string): string | null {
      const parsed = parseIp(ip);
      if (!parsed) return null;
      if (parsed.v === 4) return countryV4(ipIndex, parsed.n);
      return countryV6(ipIndex, parsed.n);
    },
    categoriesForDomain(domain: string): string[] {
      return categoriesFor(siteIndex, domain);
    },
  };
}

export function loadGeoDir(dir: string): GeoData {
  return loadGeoBytes(readDat(dir, "geoip.dat"), readDat(dir, "geosite.dat"));
}

const geoCache = new Map<string, GeoData | null>();

export function resetGeoCache(): void {
  geoCache.clear();
}

export function lookupGeo(input: { ip?: string; domain?: string }, env: GeoEnv = process.env): GeoNote | null {
  if (!geoEnabled(env)) return null;
  const data = datasetFor(env);
  if (!data) return null;
  return {
    country: input.ip ? data.countryForIp(input.ip) : null,
    categories: input.domain ? data.categoriesForDomain(input.domain) : [],
  };
}

export function annotateLine(line: string, env: GeoEnv = process.env): string {
  if (!geoEnabled(env)) return line;
  if (line.length > 8192) return line;
  const data = datasetFor(env);
  if (!data) return line;

  const countries: string[] = [];
  const categories: string[] = [];
  const seenCountry = new Set<string>();
  const seenCategory = new Set<string>();

  for (const ip of findIps(line)) {
    const country = data.countryForIp(ip);
    const safe = country && CODE_OK.test(country) ? country : null;
    if (safe && !seenCountry.has(safe)) {
      seenCountry.add(safe);
      countries.push(safe);
    }
  }
  for (const domain of findDomains(line)) {
    for (const category of data.categoriesForDomain(domain)) {
      if (!CODE_OK.test(category) || seenCategory.has(category)) continue;
      seenCategory.add(category);
      categories.push(category);
    }
  }

  let out = line;
  if (countries.length) out += ` geoip=${countries.join(",")}`;
  if (categories.length) out += ` geosite=${categories.join(",")}`;
  return out;
}

function datasetFor(env: GeoEnv): GeoData | null {
  const dir = env.INFINITUM_GEO_DIR || defaultGeoDir();
  if (geoCache.has(dir)) return geoCache.get(dir) ?? null;
  try {
    const data = loadGeoDir(dir);
    geoCache.set(dir, data);
    return data;
  } catch {
    geoCache.set(dir, null);
    return null;
  }
}

function readDat(dir: string, name: "geoip.dat" | "geosite.dat"): Buffer {
  const root = path.resolve(dir);
  const file = path.resolve(root, name);
  if (file !== path.join(root, name)) throw new Error("invalid geo data path");
  return readFileSync(file);
}

function readVarint(r: Reader): number {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    if (r.pos >= r.buf.length) throw new Error("truncated geo protobuf");
    const byte = r.buf[r.pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
  }
  throw new Error("geo protobuf varint too long");
}

function readBytes(r: Reader): Uint8Array {
  const len = readVarint(r);
  if (!Number.isInteger(len) || len < 0 || r.pos + len > r.buf.length) throw new Error("truncated geo protobuf");
  const out = r.buf.subarray(r.pos, r.pos + len);
  r.pos += len;
  return out;
}

function eachField(buf: Uint8Array, fn: (field: number, wire: number, val: number | Uint8Array) => void): void {
  const r: Reader = { buf, pos: 0 };
  while (r.pos < r.buf.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field <= 0) throw new Error("invalid geo protobuf field");
    if (wire === 0) fn(field, wire, readVarint(r));
    else if (wire === 2) fn(field, wire, readBytes(r));
    else if (wire === 1) {
      if (r.pos + 8 > r.buf.length) throw new Error("truncated geo protobuf");
      r.pos += 8;
    } else if (wire === 5) {
      if (r.pos + 4 > r.buf.length) throw new Error("truncated geo protobuf");
      r.pos += 4;
    } else {
      throw new Error("unsupported geo protobuf wire type");
    }
  }
}

function text(buf: Uint8Array): string {
  return Buffer.from(buf).toString("utf8");
}

function parseCidr(buf: Uint8Array): Cidr | null {
  let ip: Uint8Array | null = null;
  let prefix = 0;
  eachField(buf, (field, wire, val) => {
    if (field === 1 && wire === 2 && val instanceof Uint8Array) ip = val;
    else if (field === 2 && wire === 0 && typeof val === "number") prefix = val;
  });
  if (!ip) return null;
  return { ip, prefix };
}

function parseGeoIps(buf: Uint8Array): { code: string; cidrs: Cidr[]; inverse: boolean }[] {
  const entries: { code: string; cidrs: Cidr[]; inverse: boolean }[] = [];
  eachField(buf, (field, wire, val) => {
    if (field !== 1 || wire !== 2 || !(val instanceof Uint8Array)) return;
    let code = "";
    let alt = "";
    let inverse = false;
    const cidrs: Cidr[] = [];
    eachField(val, (f, w, v) => {
      if (f === 1 && w === 2 && v instanceof Uint8Array) code = text(v);
      else if (f === 5 && w === 2 && v instanceof Uint8Array) alt = text(v);
      else if (f === 3 && w === 0 && typeof v === "number") inverse = v !== 0;
      else if (f === 2 && w === 2 && v instanceof Uint8Array) {
        const cidr = parseCidr(v);
        if (cidr) cidrs.push(cidr);
      }
    });
    const name = (code || alt).trim();
    if (!name) return;
    entries.push({ code: name, cidrs, inverse });
  });
  return entries;
}

function parseGeoSites(buf: Uint8Array): { code: string; rules: DomainRule[] }[] {
  const entries: { code: string; rules: DomainRule[] }[] = [];
  eachField(buf, (field, wire, val) => {
    if (field !== 1 || wire !== 2 || !(val instanceof Uint8Array)) return;
    let code = "";
    let alt = "";
    const rules: DomainRule[] = [];
    eachField(val, (f, w, v) => {
      if (f === 1 && w === 2 && v instanceof Uint8Array) code = text(v);
      else if (f === 4 && w === 2 && v instanceof Uint8Array) alt = text(v);
      else if (f === 2 && w === 2 && v instanceof Uint8Array) {
        let type = 0;
        let value = "";
        eachField(v, (df, dw, dv) => {
          if (df === 1 && dw === 0 && typeof dv === "number") type = dv;
          else if (df === 2 && dw === 2 && dv instanceof Uint8Array) value = text(dv);
        });
        if (value) rules.push({ type, value });
      }
    });
    const name = (code || alt).trim();
    if (name) entries.push({ code: name, rules });
  });
  return entries;
}

type V4Group = { networks: Uint32Array; countries: Uint16Array };
type V6Group = { networks: bigint[]; countries: Uint16Array };
type IpIndex = { countries: string[]; v4: Map<number, V4Group>; v6: Map<number, V6Group>; v4Prefixes: number[]; v6Prefixes: number[] };

function ipv4FromBytes(bytes: Uint8Array): number {
  return (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0);
}

function ipv6FromBytes(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return n;
}

function maskV4(ip: number, prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return ip >>> 0;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0;
}

function maskV6(ip: bigint, prefix: number): bigint {
  if (prefix <= 0) return 0n;
  if (prefix >= 128) return ip;
  const shift = BigInt(128 - prefix);
  return ((ip >> shift) << shift) & ((1n << 128n) - 1n);
}

function buildIpIndex(entries: { code: string; cidrs: Cidr[]; inverse: boolean }[]): IpIndex {
  const countries: string[] = [];
  const countryId = new Map<string, number>();
  const idFor = (code: string): number => {
    const existing = countryId.get(code);
    if (existing !== undefined) return existing;
    if (countries.length >= 65535) throw new Error("too many geoip codes");
    const id = countries.length;
    countries.push(code);
    countryId.set(code, id);
    return id;
  };

  const v4Net = new Map<number, number[]>();
  const v4Country = new Map<number, number[]>();
  const v4Order = new Map<number, number[]>();
  const v6Net = new Map<number, bigint[]>();
  const v6Country = new Map<number, number[]>();
  const v6Order = new Map<number, number[]>();
  let order = 0;

  for (const entry of entries) {
    if (entry.inverse) continue;
    const id = idFor(entry.code);
    for (const cidr of entry.cidrs) {
      const current = order++;
      if (cidr.ip.length === 4 && cidr.prefix >= 0 && cidr.prefix <= 32) {
        const prefix = cidr.prefix;
        const network = maskV4(ipv4FromBytes(cidr.ip), prefix);
        pushV4(v4Net, v4Country, v4Order, prefix, network, id, current);
      } else if (cidr.ip.length === 16 && cidr.prefix >= 0 && cidr.prefix <= 128) {
        const prefix = cidr.prefix;
        const network = maskV6(ipv6FromBytes(cidr.ip), prefix);
        pushV6(v6Net, v6Country, v6Order, prefix, network, id, current);
      }
    }
  }

  const v4 = new Map<number, V4Group>();
  for (const prefix of v4Net.keys()) {
    const nets = v4Net.get(prefix)!;
    const ids = v4Country.get(prefix)!;
    const orders = v4Order.get(prefix)!;
    const idx = nets.map((_, i) => i).sort((a, b) => nets[a] - nets[b] || orders[a] - orders[b]);
    const keptNet: number[] = [];
    const keptId: number[] = [];
    let last = -1;
    let have = false;
    for (const i of idx) {
      if (have && nets[i] === last) continue;
      last = nets[i];
      have = true;
      keptNet.push(last);
      keptId.push(ids[i]);
    }
    v4.set(prefix, { networks: Uint32Array.from(keptNet), countries: Uint16Array.from(keptId) });
  }

  const v6 = new Map<number, V6Group>();
  for (const prefix of v6Net.keys()) {
    const nets = v6Net.get(prefix)!;
    const ids = v6Country.get(prefix)!;
    const orders = v6Order.get(prefix)!;
    const idx = nets.map((_, i) => i).sort((a, b) => (nets[a] < nets[b] ? -1 : nets[a] > nets[b] ? 1 : orders[a] - orders[b]));
    const keptNet: bigint[] = [];
    const keptId: number[] = [];
    let last = 0n;
    let have = false;
    for (const i of idx) {
      if (have && nets[i] === last) continue;
      last = nets[i];
      have = true;
      keptNet.push(last);
      keptId.push(ids[i]);
    }
    v6.set(prefix, { networks: keptNet, countries: Uint16Array.from(keptId) });
  }

  return {
    countries,
    v4,
    v6,
    v4Prefixes: [...v4.keys()].sort((a, b) => b - a),
    v6Prefixes: [...v6.keys()].sort((a, b) => b - a),
  };
}

function pushV4(
  nets: Map<number, number[]>,
  countries: Map<number, number[]>,
  orders: Map<number, number[]>,
  prefix: number,
  network: number,
  id: number,
  order: number,
): void {
  if (!nets.has(prefix)) {
    nets.set(prefix, []);
    countries.set(prefix, []);
    orders.set(prefix, []);
  }
  nets.get(prefix)!.push(network);
  countries.get(prefix)!.push(id);
  orders.get(prefix)!.push(order);
}

function pushV6(
  nets: Map<number, bigint[]>,
  countries: Map<number, number[]>,
  orders: Map<number, number[]>,
  prefix: number,
  network: bigint,
  id: number,
  order: number,
): void {
  if (!nets.has(prefix)) {
    nets.set(prefix, []);
    countries.set(prefix, []);
    orders.set(prefix, []);
  }
  nets.get(prefix)!.push(network);
  countries.get(prefix)!.push(id);
  orders.get(prefix)!.push(order);
}

function binarySearchU32(list: Uint32Array, target: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const value = list[mid];
    if (value === target) return mid;
    if (value < target) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}

function binarySearchBig(list: bigint[], target: bigint): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const value = list[mid];
    if (value === target) return mid;
    if (value < target) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}

function countryV4(index: IpIndex, ip: number): string | null {
  for (const prefix of index.v4Prefixes) {
    const group = index.v4.get(prefix);
    if (!group) continue;
    const at = binarySearchU32(group.networks, maskV4(ip, prefix));
    if (at >= 0) return index.countries[group.countries[at]] ?? null;
  }
  return null;
}

function countryV6(index: IpIndex, ip: bigint): string | null {
  for (const prefix of index.v6Prefixes) {
    const group = index.v6.get(prefix);
    if (!group) continue;
    const at = binarySearchBig(group.networks, maskV6(ip, prefix));
    if (at >= 0) return index.countries[group.countries[at]] ?? null;
  }
  return null;
}

type SiteIndex = {
  full: Map<string, string[]>;
  root: Map<string, string[]>;
  plain: { keyword: string; category: string }[];
  regex: { re: RegExp; category: string }[];
};

function addCode(map: Map<string, string[]>, key: string, code: string): void {
  const list = map.get(key);
  if (!list) map.set(key, [code]);
  else if (!list.includes(code)) list.push(code);
}

function buildSiteIndex(entries: { code: string; rules: DomainRule[] }[]): SiteIndex {
  const full = new Map<string, string[]>();
  const root = new Map<string, string[]>();
  const plain: { keyword: string; category: string }[] = [];
  const regex: { re: RegExp; category: string }[] = [];
  for (const entry of entries) {
    for (const rule of entry.rules) {
      if (rule.type === 1) {
        try {
          regex.push({ re: new RegExp(rule.value), category: entry.code });
        } catch {
          // Skip a pattern this runtime cannot compile. Full and root rules still load.
        }
        continue;
      }
      const value = rule.value.trim().toLowerCase().replace(/\.+$/, "");
      if (!value) continue;
      if (rule.type === 3) addCode(full, value, entry.code);
      else if (rule.type === 2) addCode(root, value, entry.code);
      else if (rule.type === 0) plain.push({ keyword: value, category: entry.code });
    }
  }
  return { full, root, plain, regex };
}

function normalizeDomain(input: string): string | null {
  let domain = input.trim().toLowerCase();
  while (domain.endsWith(".")) domain = domain.slice(0, -1);
  if (domain.length === 0 || domain.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(domain)) return null;
  const labels = domain.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return null;
  return domain;
}

function categoriesFor(index: SiteIndex, domain: string): string[] {
  const normalized = normalizeDomain(domain);
  if (!normalized) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (codes: readonly string[] | undefined) => {
    if (!codes) return;
    for (const code of codes) {
      if (seen.has(code)) continue;
      seen.add(code);
      out.push(code);
    }
  };
  add(index.full.get(normalized));
  let rest = normalized;
  while (rest) {
    add(index.root.get(rest));
    const dot = rest.indexOf(".");
    if (dot < 0) break;
    rest = rest.slice(dot + 1);
  }
  for (const rule of index.plain) {
    if (normalized.includes(rule.keyword)) add([rule.category]);
  }
  for (const rule of index.regex) {
    if (rule.re.test(normalized)) add([rule.category]);
  }
  return out;
}

function parseV4(input: string): number | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

function parseV6(input: string): bigint | null {
  const raw = input.trim().toLowerCase().split("%", 1)[0];
  if (!raw || raw.includes(":::")) return null;
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const expand = (part: string): number[] | null => {
    if (!part) return [];
    const items = part.split(":");
    const out: number[] = [];
    let end = items.length;
    let v4: number[] | null = null;
    if (items[items.length - 1].includes(".")) {
      const n = parseV4(items[items.length - 1]);
      if (n === null) return null;
      v4 = [(n >>> 16) & 0xffff, n & 0xffff];
      end -= 1;
    }
    for (let i = 0; i < end; i++) {
      if (!/^[0-9a-f]{1,4}$/.test(items[i])) return null;
      out.push(Number.parseInt(items[i], 16));
    }
    if (v4) out.push(...v4);
    return out;
  };
  const left = expand(halves[0]);
  const right = halves.length === 2 ? expand(halves[1]) : [];
  if (!left || !right) return null;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
  } else if (left.length + right.length > 7) {
    return null;
  }
  const zeros = halves.length === 2 ? 8 - (left.length + right.length) : 0;
  const groups = [...left, ...new Array<number>(zeros).fill(0), ...right];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const group of groups) n = (n << 16n) | BigInt(group);
  return n;
}

function parseIp(input: string): { v: 4; n: number } | { v: 6; n: bigint } | null {
  const value = input.trim();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    const n = parseV4(value);
    return n === null ? null : { v: 4, n };
  }
  if (value.includes(":")) {
    const n = parseV6(value);
    if (n === null) return null;
    if ((n >> 32n) === 0xffffn) return { v: 4, n: Number(n & 0xffffffffn) };
    return { v: 6, n };
  }
  return null;
}

function findIps(line: string): string[] {
  const v4 = /(?:^|[^0-9])((?:\d{1,3}\.){3}\d{1,3})(?![0-9.])/g;
  const v6 = /(?:^|[^A-Fa-f0-9:])((?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4})(?![A-Fa-f0-9:])/g;
  return [...line.matchAll(v4), ...line.matchAll(v6)].map((match) => match[1]);
}

function findDomains(line: string): string[] {
  const domain = /(?:^|[^A-Za-z0-9.-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})(?![A-Za-z0-9.-])/g;
  return [...line.matchAll(domain)].map((match) => match[1]);
}
