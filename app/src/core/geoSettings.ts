import fs from "node:fs";
import path from "node:path";

export type FabricSettings = {
  geoRouting: boolean;
};

export const DEFAULT_SETTINGS: FabricSettings = {
  geoRouting: false,
};

export function loadSettings(file: string): FabricSettings {
  if (!fs.existsSync(file)) return { ...DEFAULT_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  return { geoRouting: (parsed as { geoRouting?: unknown }).geoRouting === true };
}

export function saveSettings(file: string, settings: FabricSettings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({ geoRouting: settings.geoRouting === true }, null, 2)}\n`;
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.partial`);
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}
