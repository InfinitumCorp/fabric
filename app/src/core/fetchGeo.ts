import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class ChecksumMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksumMismatch";
  }
}

export type GeoDatasetSpec = {
  id: "geoip" | "geosite";
  filename: "geoip.dat" | "geosite.dat";
  upstreamFilename: string;
  url: string;
  sha256Url: string;
  tag: string;
  repository: string;
  sha256: string;
  license: string;
};

export type GeoLock = {
  source: "v2fly";
  datasets: GeoDatasetSpec[];
};

const BANNED = ["loyalsoldier", "sing-box", "singbox", "sagernet"];
const DOWNLOAD_CAP = 48 * 1024 * 1024;
const ALLOWED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function defaultLockPath(): string {
  return path.join(repoRoot(), "geo", "geo.lock.json");
}

export function defaultDataDir(): string {
  return path.join(repoRoot(), "data", "geo");
}

export function defaultSettingsPath(): string {
  return path.join(repoRoot(), "app", "fabric.settings.json");
}

function sameHash(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseSha256Sum(text: string, filename: string): string {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) throw new ChecksumMismatch("stop: official sha256sum is empty");
  const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line);
  if (!match) throw new ChecksumMismatch("stop: official sha256sum is unreadable");
  if (match[2] !== filename) {
    throw new ChecksumMismatch(`stop: official sha256sum names ${match[2]}, expected ${filename}`);
  }
  return match[1].toLowerCase();
}

export function assertV2flyUrl(url: string, id: "geoip" | "geosite"): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("stop: geo dataset URL must be https");
  if (parsed.username || parsed.password) throw new Error("stop: geo dataset URL has credentials");
  const haystack = url.toLowerCase();
  if (BANNED.some((item) => haystack.includes(item))) throw new Error("stop: geo dataset source is not v2fly");
  const prefix =
    id === "geoip"
      ? "https://github.com/v2fly/geoip/releases/download/"
      : "https://github.com/v2fly/domain-list-community/releases/download/";
  if (!url.startsWith(prefix)) throw new Error("stop: geo dataset URL is not a v2fly release asset");
}

export function assertDatasetSpec(spec: GeoDatasetSpec): void {
  if (spec.id !== "geoip" && spec.id !== "geosite") throw new Error("stop: unknown geo dataset");
  const filename = spec.id === "geoip" ? "geoip.dat" : "geosite.dat";
  const upstream = spec.id === "geoip" ? "geoip.dat" : "dlc.dat";
  const repository = spec.id === "geoip" ? "https://github.com/v2fly/geoip" : "https://github.com/v2fly/domain-list-community";
  if (spec.filename !== filename || spec.upstreamFilename !== upstream) throw new Error("stop: unexpected geo filename");
  if (spec.repository !== repository) throw new Error("stop: unexpected geo repository");
  if (!/^[0-9]{8,20}$/.test(spec.tag)) throw new Error("stop: unexpected geo tag");
  if (!/^[a-f0-9]{64}$/.test(spec.sha256)) throw new Error("stop: lockfile sha256 is invalid");
  assertV2flyUrl(spec.url, spec.id);
  assertV2flyUrl(spec.sha256Url, spec.id);
  if (!spec.url.endsWith(`/${spec.tag}/${spec.upstreamFilename}`)) throw new Error("stop: geo asset URL does not match the lockfile");
  if (!spec.sha256Url.endsWith(`/${spec.tag}/${spec.upstreamFilename}.sha256sum`)) {
    throw new Error("stop: geo checksum URL does not match the lockfile");
  }
}

export function assertChecksum(bytes: Uint8Array, officialText: string, spec: GeoDatasetSpec): void {
  const official = parseSha256Sum(officialText, spec.upstreamFilename);
  const actual = sha256Hex(bytes);
  const expected = spec.sha256.toLowerCase();
  if (!sameHash(official, expected)) {
    throw new ChecksumMismatch(`stop: official sha256sum for ${spec.upstreamFilename} is ${official}, lockfile has ${expected}`);
  }
  if (!sameHash(actual, expected)) {
    throw new ChecksumMismatch(`stop: downloaded ${spec.upstreamFilename} sha256 is ${actual}, lockfile has ${expected}`);
  }
}

export function loadLock(file: string): GeoLock {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as GeoLock;
  if (parsed.source !== "v2fly" || !Array.isArray(parsed.datasets) || parsed.datasets.length !== 2) {
    throw new Error("stop: geo lockfile must list the two v2fly datasets");
  }
  const ids = parsed.datasets.map((item) => item.id);
  if (ids[0] !== "geoip" || ids[1] !== "geosite") throw new Error("stop: geo lockfile order is geoip then geosite");
  for (const spec of parsed.datasets) assertDatasetSpec(spec);
  return parsed;
}

export function installVerified(spec: GeoDatasetSpec, bytes: Uint8Array, officialText: string, destDir: string): string {
  assertDatasetSpec(spec);
  assertChecksum(bytes, officialText, spec);
  if (bytes.byteLength > DOWNLOAD_CAP) throw new Error("stop: geo download exceeds 48MB");
  fs.mkdirSync(destDir, { recursive: true });
  const finalPath = path.join(destDir, spec.filename);
  const tmp = path.join(destDir, `.${spec.filename}.${process.pid}.partial`);
  try {
    fs.writeFileSync(tmp, bytes);
    const written = fs.readFileSync(tmp);
    assertChecksum(written, officialText, spec);
    fs.renameSync(tmp, finalPath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return finalPath;
}

function assertDownloadHost(finalUrl: string): void {
  const host = new URL(finalUrl).hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`stop: unexpected download host ${host}`);
}

async function download(url: string, id: "geoip" | "geosite"): Promise<{ bytes: Uint8Array; finalUrl: string }> {
  assertV2flyUrl(url, id);
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  assertDownloadHost(response.url);
  if (!response.ok) throw new Error(`stop: download failed ${response.status} for ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > DOWNLOAD_CAP) throw new Error("stop: geo download exceeds 48MB");
  return { bytes, finalUrl: response.url };
}

export type FetchReport = { filename: string; sha256: string; bytes: number; path: string };

export async function fetchLockedDatasets(lockFile = defaultLockPath(), destDir = defaultDataDir()): Promise<FetchReport[]> {
  const lock = loadLock(lockFile);
  const reports: FetchReport[] = [];
  for (const spec of lock.datasets) {
    const official = await download(spec.sha256Url, spec.id);
    const officialText = new TextDecoder("utf-8", { fatal: true }).decode(official.bytes);
    const published = parseSha256Sum(officialText, spec.upstreamFilename);
    if (!sameHash(published, spec.sha256.toLowerCase())) {
      throw new ChecksumMismatch(
        `stop: official sha256sum for ${spec.upstreamFilename} is ${published}, lockfile has ${spec.sha256.toLowerCase()}`,
      );
    }
    const file = await download(spec.url, spec.id);
    const saved = installVerified(spec, file.bytes, officialText, destDir);
    reports.push({ filename: spec.filename, sha256: spec.sha256.toLowerCase(), bytes: file.bytes.byteLength, path: saved });
  }
  return reports;
}
