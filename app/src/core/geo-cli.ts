import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir, defaultLockPath, defaultSettingsPath, fetchLockedDatasets } from "./fetchGeo.ts";
import { loadSettings, saveSettings } from "./geoSettings.ts";

export type GeoCli =
  | { action: "fetch"; out: string; lock: string }
  | { action: "set"; enabled: boolean; settings: string }
  | { action: "status"; settings: string }
  | { action: "help" };

export function parseGeoArgs(argv: string[]): GeoCli {
  const args = argv.slice(2);
  let settings = defaultSettingsPath();
  let out = defaultDataDir();
  let lock = defaultLockPath();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--settings") {
      settings = requirePath(args[++i], "--settings");
      continue;
    }
    if (arg === "--out") {
      out = requirePath(args[++i], "--out");
      continue;
    }
    if (arg === "--lock") {
      lock = requirePath(args[++i], "--lock");
      continue;
    }
    rest.push(arg);
  }
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "help") return { action: "help" };
  if (rest[0] === "fetch") return { action: "fetch", out, lock };
  if (rest[0] === "--geo-routing") {
    const value = (rest[1] ?? "status").toLowerCase();
    if (value === "status") return { action: "status", settings };
    if (value === "on" || value === "true" || value === "1") return { action: "set", enabled: true, settings };
    if (value === "off" || value === "false" || value === "0") return { action: "set", enabled: false, settings };
    throw new Error("stop: --geo-routing expects on or off");
  }
  throw new Error("stop: unknown geo command");
}

function requirePath(value: string | undefined, flag: string): string {
  if (!value || value.startsWith("-")) throw new Error(`stop: ${flag} needs a path`);
  return path.resolve(value);
}

export function helpText(): string {
  return [
    "FabriC++ geo datasets",
    "  fetch                 download v2fly geoip.dat and geosite.dat into data/geo",
    "  --geo-routing on|off  persist the geo routing setting (default off)",
    "  --geo-routing status  print on or off",
    "  --settings <file>     settings file (default app/fabric.settings.json)",
    "  --out <dir>           download directory",
    "  --lock <file>         lockfile",
  ].join("\n");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

export async function runGeoCli(argv: string[]): Promise<number> {
  try {
    const command = parseGeoArgs(argv);
    if (command.action === "help") {
      console.log(helpText());
      return 0;
    }
    if (command.action === "status") {
      console.log(loadSettings(command.settings).geoRouting ? "on" : "off");
      return 0;
    }
    if (command.action === "set") {
      saveSettings(command.settings, { geoRouting: command.enabled });
      console.log(command.enabled ? "on" : "off");
      return 0;
    }
    const reports = await fetchLockedDatasets(command.lock, command.out);
    for (const report of reports) {
      console.log(`verified ${report.filename} sha256 ${report.sha256} bytes ${report.bytes}`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "stop: geo command failed");
    return 1;
  }
}

if (isDirectRun()) {
  runGeoCli(process.argv).then((code) => {
    process.exitCode = code;
  });
}
