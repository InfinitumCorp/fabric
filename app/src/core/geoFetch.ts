// Download pinned v2fly geoip.dat and geosite.dat. Checksums must match the lockfile
// and the publisher .sha256sum asset. The bytes are written under app/data/geo, which is gitignored.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultGeoDir } from "./geo.ts";

const DAT_LIMIT = 64 * 1024 * 1024;
const SUM_LIMIT = 1024;

const SOURCES = {
  geoip: {
    repo: "v2fly/geoip",
    asset: "geoip.dat",
    filename: "geoip.dat",
    license: "CC-BY-SA-4.0",
    source: "https://github.com/v2fly/geoip",
  },
  geosite: {
    repo: "v2fly/domain-list-community",
    asset: "dlc.dat",
    filename: "geosite.dat",
    license: "MIT",
    source: "https://github.com/v2fly/domain-list-community",
  },
} as const;

export type GeoDatasetId = keyof typeof SOURCES;

export type GeoDatasetLock = {
  id: GeoDatasetId;
  filename: "geoip.dat" | "geosite.dat";
  upstreamAsset: "geoip.dat" | "dlc.dat";
  tag: string;
  license: string;
  url: string;
  sha256: string;
  sha256sumUrl: string;
  source: string;
};

export type GeoLock = {
  version: 1;
  datasets: GeoDatasetLock[];
};

export class GeoChecksumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeoChecksumError";
  }
}

export function defaultLockPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../geo.lock.json");
}

export function releaseUrl(repo: string, tag: string, asset: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${asset}`;
}

export function loadLock(text: string): GeoLock {
  const parsed = JSON.parse(text) as GeoLock;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.datasets)) {
    throw new Error("geo lockfile must be version 1 with a datasets list");
  }
  if (parsed.datasets.length !== 2) throw new Error("geo lockfile must list geoip and geosite");
  const ids = parsed.datasets.map((entry) => entry.id);
  if (ids[0] !== "geoip" || ids[1] !== "geosite") throw new Error("geo lockfile order must be geoip then geosite");
  for (const entry of parsed.datasets) validateEntry(entry);
  return parsed;
}

export function parseSha256Sum(text: string): { sha256: string; name: string } {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith("#"));
  if (!line) throw new Error("empty sha256sum");
  const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line);
  if (!match) throw new Error(`unrecognized sha256sum line: ${line}`);
  return { sha256: match[1].toLowerCase(), name: match[2] };
}

export async function fetchGeoDatasets(options: {
  lockPath?: string;
  destDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ filename: string; sha256: string }[]> {
  const lockPath = options.lockPath ?? defaultLockPath();
  const destDir = path.resolve(options.destDir ?? defaultGeoDir());
  const fetchImpl = options.fetchImpl ?? fetch;
  const lock = loadLock(await readFile(lockPath, "utf8"));
  await mkdir(destDir, { recursive: true });
  const written: { filename: string; sha256: string }[] = [];
  for (const entry of lock.datasets) {
    const sumText = await readLimited(fetchImpl, entry.sha256sumUrl, SUM_LIMIT);
    const official = parseSha256Sum(sumText.toString("utf8"));
    if (official.name !== entry.upstreamAsset) {
      throw new GeoChecksumError(
        `${entry.filename}: official sha256sum names ${official.name}, expected ${entry.upstreamAsset}`,
      );
    }
    if (official.sha256 !== entry.sha256) {
      throw new GeoChecksumError(
        [
          `${entry.filename}: official sha256sum does not match the lockfile`,
          `  lock:     ${entry.sha256}`,
          `  official: ${official.sha256}`,
        ].join("\n"),
      );
    }
    const bytes = await readLimited(fetchImpl, entry.url, DAT_LIMIT);
    const computed = createHash("sha256").update(bytes).digest("hex");
    const finalPath = path.join(destDir, entry.filename);
    const partial = path.join(destDir, `.${entry.filename}.partial`);
    if (computed !== entry.sha256 || computed !== official.sha256) {
      await rm(partial, { force: true });
      throw new GeoChecksumError(
        [
          `${entry.filename}: downloaded bytes do not match the pinned checksum`,
          `  lock:     ${entry.sha256}`,
          `  official: ${official.sha256}`,
          `  computed: ${computed}`,
        ].join("\n"),
      );
    }
    await writeFile(partial, bytes);
    try {
      const again = createHash("sha256").update(await readFile(partial)).digest("hex");
      if (again !== entry.sha256) {
        throw new GeoChecksumError(`${entry.filename}: partial file checksum changed before publish`);
      }
      await rename(partial, finalPath);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    written.push({ filename: entry.filename, sha256: computed });
  }
  return written;
}

async function readLimited(fetchImpl: typeof fetch, url: string, limit: number): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
  if (!response.body) throw new Error(`download failed (empty) for ${url}`);
  const chunks: Buffer[] = [];
  let size = 0;
  const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new Error(`download exceeded size cap for ${url}`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function validateEntry(entry: GeoDatasetLock): void {
  const spec = SOURCES[entry.id];
  if (!spec) throw new Error(`refusing geo dataset ${String(entry.id)}`);
  if (!/^[0-9]{8,20}$/.test(entry.tag)) throw new Error(`${entry.id}: release tag must be the v2fly numeric tag`);
  if (entry.filename !== spec.filename) throw new Error(`${entry.id}: local filename must be ${spec.filename}`);
  if (entry.upstreamAsset !== spec.asset) throw new Error(`${entry.id}: upstream asset must be ${spec.asset}`);
  if (entry.license !== spec.license) throw new Error(`${entry.id}: license must stay ${spec.license}`);
  if (entry.source !== spec.source) throw new Error(`${entry.id}: source must stay ${spec.source}`);
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`${entry.id}: sha256 must be 64 lowercase hex characters`);
  const url = releaseUrl(spec.repo, entry.tag, spec.asset);
  const sumUrl = `${url}.sha256sum`;
  if (entry.url !== url) throw new Error(`${entry.id}: url is not the v2fly release asset ${url}`);
  if (entry.sha256sumUrl !== sumUrl) throw new Error(`${entry.id}: sha256sumUrl is not the v2fly release asset ${sumUrl}`);
}

export function isDirectRun(entry = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

export async function main(): Promise<void> {
  const written = await fetchGeoDatasets({});
  for (const file of written) console.log(`wrote ${file.filename} sha256 ${file.sha256}`);
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exitCode = 1;
  });
}
