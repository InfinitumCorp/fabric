export const DomainKind = {
  Plain: 0,
  Regex: 1,
  Domain: 2,
  Full: 3,
} as const;

export type Cidr = { ip: Uint8Array; prefix: number };
export type GeoIpEntry = { code: string; cidrs: Cidr[]; reverseMatch: boolean };
export type DomainRule = { type: number; value: string };
export type GeoSiteEntry = { category: string; domains: DomainRule[] };

export type CidrInput = { ip: string; prefix: number };
export type GeoIpInput = { code: string; cidrs: CidrInput[]; reverseMatch?: boolean };
export type DomainAttrInput = { key: string; bool?: boolean };
export type DomainInput = { type: number; value: string; attrs?: DomainAttrInput[] };
export type GeoSiteInput = { category: string; domains: DomainInput[] };

type IndexedRule = { category: string; type: number; value: string; regex: RegExp | null };

export type GeoLists = {
  countryOf(ip: string): string | null;
  matches(ip: string): string[];
  categoriesOf(domain: string): string[];
};

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

export function parseIp(input: string): Uint8Array | null {
  let value = input.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (!value) return null;
  if (value.includes(".")) {
    if (!value.includes(":")) return parseIpv4(value);
  } else if (!value.includes(":")) {
    return null;
  }
  return parseIpv6(value);
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(value: string): Uint8Array | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = parseIpv6Side(halves[0]);
  if (!head) return null;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return groupsToBytes(head);
  }
  const tail = parseIpv6Side(halves[1]);
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return groupsToBytes(head.concat(Array(missing).fill(0), tail));
}

function parseIpv6Side(side: string): number[] | null {
  if (side === "") return [];
  const parts = side.split(":");
  const groups: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.includes(".")) {
      if (i !== parts.length - 1) return null;
      const v4 = parseIpv4(part);
      if (!v4) return null;
      groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

function groupsToBytes(groups: number[]): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (groups[i] >> 8) & 0xff;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  return out;
}

export function normalizeDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > 253) return null;
  if (/[\s/@:\\]/.test(host)) return null;
  return host;
}

export function cidrContains(ip: Uint8Array, network: Uint8Array, prefix: number): boolean {
  if (ip.length !== network.length) return false;
  if (prefix < 0 || prefix > ip.length * 8) return false;
  let bits = prefix;
  for (let i = 0; i < ip.length && bits > 0; i++) {
    const take = bits >= 8 ? 8 : bits;
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((ip[i] & mask) !== (network[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

function readVarint(buf: Uint8Array, offset: number, end: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < end && shift <= 28) {
    const b = buf[pos++];
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value, next: pos };
    shift += 7;
  }
  throw new Error("truncated geo list");
}

function skipValue(buf: Uint8Array, offset: number, end: number, wire: number): number {
  if (wire === 0) return readVarint(buf, offset, end).next;
  if (wire === 1) {
    if (offset + 8 > end) throw new Error("truncated geo list");
    return offset + 8;
  }
  if (wire === 5) {
    if (offset + 4 > end) throw new Error("truncated geo list");
    return offset + 4;
  }
  if (wire === 2) {
    const len = readVarint(buf, offset, end);
    const next = len.next + len.value;
    if (len.value < 0 || next > end) throw new Error("truncated geo list");
    return next;
  }
  throw new Error("truncated geo list");
}

function readLen(buf: Uint8Array, offset: number, end: number): { start: number; next: number } {
  const len = readVarint(buf, offset, end);
  const start = len.next;
  const next = start + len.value;
  if (len.value < 0 || next > end) throw new Error("truncated geo list");
  return { start, next };
}

function readString(buf: Uint8Array, start: number, end: number): string {
  try {
    return textDecoder.decode(buf.subarray(start, end));
  } catch {
    throw new Error("truncated geo list");
  }
}

export function decodeGeoIp(buf: Uint8Array): GeoIpEntry[] {
  const entries: GeoIpEntry[] = [];
  let i = 0;
  const end = buf.length;
  while (i < end) {
    const key = readVarint(buf, i, end);
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (field === 1 && wire === 2) {
      const slice = readLen(buf, key.next, end);
      entries.push(parseGeoIp(buf, slice.start, slice.next));
      i = slice.next;
    } else {
      i = skipValue(buf, key.next, end, wire);
    }
  }
  return entries;
}

function parseGeoIp(buf: Uint8Array, start: number, end: number): GeoIpEntry {
  let code = "";
  const cidrs: Cidr[] = [];
  let reverseMatch = false;
  let i = start;
  while (i < end) {
    const key = readVarint(buf, i, end);
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (field === 1 && wire === 2) {
      const slice = readLen(buf, key.next, end);
      code = readString(buf, slice.start, slice.next);
      i = slice.next;
    } else if (field === 2 && wire === 2) {
      const slice = readLen(buf, key.next, end);
      cidrs.push(parseCidr(buf, slice.start, slice.next));
      i = slice.next;
    } else if (field === 3 && wire === 0) {
      const value = readVarint(buf, key.next, end);
      reverseMatch = value.value !== 0;
      i = value.next;
    } else {
      i = skipValue(buf, key.next, end, wire);
    }
  }
  return { code, cidrs, reverseMatch };
}

function parseCidr(buf: Uint8Array, start: number, end: number): Cidr {
  let ip = new Uint8Array();
  let prefix = 0;
  let i = start;
  while (i < end) {
    const key = readVarint(buf, i, end);
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (field === 1 && wire === 2) {
      const slice = readLen(buf, key.next, end);
      ip = buf.slice(slice.start, slice.next);
      i = slice.next;
    } else if (field === 2 && wire === 0) {
      const value = readVarint(buf, key.next, end);
      prefix = value.value;
      i = value.next;
    } else {
      i = skipValue(buf, key.next, end, wire);
    }
  }
  if (ip.length !== 4 && ip.length !== 16) throw new Error("truncated geo list");
  if (prefix < 0 || prefix > ip.length * 8) throw new Error("truncated geo list");
  return { ip, prefix };
}

export function decodeGeoSite(buf: Uint8Array): GeoSiteEntry[] {
  const entries: GeoSiteEntry[] = [];
  let i = 0;
  const end = buf.length;
  while (i < end) {
    const key = readVarint(buf, i, end);
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (field === 1 && wire === 2) {
      const slice = readLen(buf, key.next, end);
      entries.push(parseGeoSite(buf, slice.start, slice.next));
      i = slice.next;
    } else {
      i = skipValue(buf, key.next, end, wire);
    }
  }
  return entries;
}

function parseGeoSite(buf: Uint8Array, start: number, end: number): GeoSiteEntry {
  let category = "";
  const domains: DomainRule[] = [];
  let i = start;
  while (i < end) {
    const key = readVarint(buf, i, end);
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (field === 1 && wire === 2) {
      const slice = readLen(buf, key.next, end);
      category = readString(buf, slice.start, slice.next);
      i = slice.next;
    } else if (field === 2 && wire === 2) {
      const slice = readLen(buf, key.next, end);
      domains.push(parseDomain(buf, slice.start, slice.next));
      i = slice.next;
    } else {
      i = skipValue(buf, key.next, end, wire);
    }
  }
  return { category, domains };
}

function parseDomain(buf: Uint8Array, start: number, end: number): DomainRule {
  let type = DomainKind.Plain;
  let value = "";
  let i = start;
  while (i < end) {
    const key = readVarint(buf, i, end);
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (field === 1 && wire === 0) {
      const parsed = readVarint(buf, key.next, end);
      type = parsed.value;
      i = parsed.next;
    } else if (field === 2 && wire === 2) {
      const slice = readLen(buf, key.next, end);
      value = readString(buf, slice.start, slice.next);
      i = slice.next;
    } else {
      i = skipValue(buf, key.next, end, wire);
    }
  }
  return { type, value };
}

function entryHit(entry: GeoIpEntry, ip: Uint8Array): { prefix: number } | null {
  let matched = false;
  let prefix = -1;
  for (const cidr of entry.cidrs) {
    if (!cidrContains(ip, cidr.ip, cidr.prefix)) continue;
    matched = true;
    if (cidr.prefix > prefix) prefix = cidr.prefix;
  }
  if (entry.reverseMatch) return matched ? null : { prefix: -1 };
  return matched ? { prefix } : null;
}

export function loadGeoLists(geoip: Uint8Array, geosite: Uint8Array): GeoLists {
  const ipEntries = decodeGeoIp(geoip);
  const siteEntries = decodeGeoSite(geosite);
  const byHost = new Map<string, IndexedRule[]>();
  const scans: IndexedRule[] = [];
  for (const site of siteEntries) {
    if (!site.category) continue;
    for (const domain of site.domains) {
      const value = domain.value.trim().toLowerCase();
      if (!value || value.length > 512) continue;
      if (domain.type === DomainKind.Regex) {
        let regex: RegExp | null = null;
        try {
          regex = new RegExp(domain.value);
        } catch {
          continue;
        }
        scans.push({ category: site.category, type: domain.type, value, regex });
        continue;
      }
      if (domain.type === DomainKind.Plain) {
        scans.push({ category: site.category, type: domain.type, value, regex: null });
        continue;
      }
      const rule = { category: site.category, type: domain.type, value, regex: null };
      const bucket = byHost.get(value);
      if (bucket) bucket.push(rule);
      else byHost.set(value, [rule]);
    }
  }

  return {
    countryOf(ip: string): string | null {
      const bytes = parseIp(ip);
      if (!bytes) return null;
      let best: { code: string; prefix: number; index: number } | null = null;
      ipEntries.forEach((entry, index) => {
        if (entry.reverseMatch || !/^[A-Za-z]{2}$/.test(entry.code)) return;
        const hit = entryHit(entry, bytes);
        if (!hit) return;
        if (!best || hit.prefix > best.prefix || (hit.prefix === best.prefix && index < best.index)) {
          best = { code: entry.code.toUpperCase(), prefix: hit.prefix, index };
        }
      });
      return best ? best.code : null;
    },
    matches(ip: string): string[] {
      const bytes = parseIp(ip);
      if (!bytes) return [];
      const codes: string[] = [];
      for (const entry of ipEntries) {
        if (!entry.code || !entryHit(entry, bytes)) continue;
        if (!codes.includes(entry.code)) codes.push(entry.code);
      }
      return codes;
    },
    categoriesOf(domain: string): string[] {
      const host = normalizeDomain(domain);
      if (!host || parseIp(host)) return [];
      const found = new Set<string>();
      const labels = host.split(".");
      for (let i = 0; i < labels.length; i++) {
        const suffix = labels.slice(i).join(".");
        const rules = byHost.get(suffix);
        if (!rules) continue;
        for (const rule of rules) {
          if (rule.value !== suffix) continue;
          if (rule.type === DomainKind.Full && host === suffix) found.add(rule.category);
          if (rule.type === DomainKind.Domain && (host === suffix || host.endsWith(`.${suffix}`))) found.add(rule.category);
        }
      }
      for (const rule of scans) {
        if (rule.type === DomainKind.Plain && host.includes(rule.value)) found.add(rule.category);
        else if (rule.type === DomainKind.Regex && rule.regex?.test(host)) found.add(rule.category);
      }
      return [...found].sort();
    },
  };
}

function encodeVarint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) throw new Error("bad varint");
  const out: number[] = [];
  let rest = value;
  while (rest > 127) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

function encodeKey(field: number, wire: number): number[] {
  return encodeVarint(field * 8 + wire);
}

function encodeLen(field: number, data: number[]): number[] {
  return encodeKey(field, 2).concat(encodeVarint(data.length), data);
}

function encodeString(field: number, value: string): number[] {
  return encodeLen(field, [...textEncoder.encode(value)]);
}

function encodeVarintField(field: number, value: number): number[] {
  if (value === 0) return [];
  return encodeKey(field, 0).concat(encodeVarint(value));
}

function encodeCidr(cidr: Cidr): number[] {
  const ip = encodeLen(1, [...cidr.ip]);
  return ip.concat(encodeVarintField(2, cidr.prefix));
}

export function encodeGeoIp(entries: GeoIpInput[]): Uint8Array {
  const parts: number[] = [];
  for (const entry of entries) {
    let body = encodeString(1, entry.code);
    for (const cidr of entry.cidrs) {
      const ip = parseIp(cidr.ip);
      if (!ip) throw new Error(`bad cidr ${cidr.ip}`);
      body = body.concat(encodeLen(2, encodeCidr({ ip, prefix: cidr.prefix })));
    }
    if (entry.reverseMatch) body = body.concat(encodeVarintField(3, 1));
    parts.push(...encodeLen(1, body));
  }
  return Uint8Array.from(parts);
}

function encodeAttribute(attr: DomainAttrInput): number[] {
  let body = encodeString(1, attr.key);
  if (attr.bool) body = body.concat(encodeVarintField(2, 1));
  return encodeLen(3, body);
}

export function encodeGeoSite(entries: GeoSiteInput[]): Uint8Array {
  const parts: number[] = [];
  for (const entry of entries) {
    let body = encodeString(1, entry.category);
    for (const domain of entry.domains) {
      let domainBody = encodeVarintField(1, domain.type);
      domainBody = domainBody.concat(encodeString(2, domain.value));
      for (const attr of domain.attrs ?? []) domainBody = domainBody.concat(encodeAttribute(attr));
      body = body.concat(encodeLen(2, domainBody));
    }
    parts.push(...encodeLen(1, body));
  }
  return Uint8Array.from(parts);
}

export function syntheticGeoIp(): GeoIpInput[] {
  return [
    { code: "US", cidrs: [{ ip: "1.2.3.0", prefix: 24 }, { ip: "198.51.100.9", prefix: 32 }] },
    { code: "DE", cidrs: [{ ip: "203.0.113.10", prefix: 32 }, { ip: "198.51.100.0", prefix: 24 }] },
    { code: "FR", cidrs: [{ ip: "198.51.100.128", prefix: 25 }] },
    { code: "SE", cidrs: [{ ip: "2001:db8::", prefix: 32 }] },
    { code: "PRIVATE", cidrs: [{ ip: "10.0.0.0", prefix: 8 }] },
    { code: "ZZ", reverseMatch: true, cidrs: [{ ip: "9.9.9.9", prefix: 32 }] },
  ];
}

export function syntheticGeoSite(): GeoSiteInput[] {
  return [
    { category: "example", domains: [{ type: DomainKind.Domain, value: "example.com", attrs: [{ key: "test", bool: true }] }] },
    { category: "news", domains: [{ type: DomainKind.Full, value: "news.example" }] },
    { category: "plain", domains: [{ type: DomainKind.Plain, value: "keyword" }] },
    { category: "chat", domains: [{ type: DomainKind.Regex, value: "^only\\.fabric\\.test$" }] },
  ];
}
