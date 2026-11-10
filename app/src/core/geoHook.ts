import fs from "node:fs";
import path from "node:path";
import { canSend, type RoomSecurity, type SendCheck } from "./rules.ts";
import { redact } from "./redact.ts";
import { loadGeoLists, type GeoLists } from "./geoDat.ts";

export type PeerAddress = {
  ip?: string;
  domain?: string;
};

export type GeoAnnotation = {
  country: string | null;
  categories: string[];
};

export type GeoGate = {
  enabled: boolean;
  lists: GeoLists | null;
};

const ON = new Set(["1", "true", "on", "yes"]);
const OFF = new Set(["0", "false", "off", "no"]);

export function geoFeatureEnabled(envValue: string | undefined, geoRouting: boolean): boolean {
  if (envValue === undefined || envValue.trim() === "") return geoRouting === true;
  const flag = envValue.trim().toLowerCase();
  if (ON.has(flag)) return true;
  if (OFF.has(flag)) return false;
  return false;
}

export function openGeoGate(envValue: string | undefined, geoRouting: boolean, lists: GeoLists | null): GeoGate {
  return {
    enabled: geoFeatureEnabled(envValue, geoRouting),
    lists,
  };
}

export function annotateAddress(lists: GeoLists, peer: PeerAddress): GeoAnnotation {
  return {
    country: peer.ip ? lists.countryOf(peer.ip) : null,
    categories: peer.domain ? lists.categoriesOf(peer.domain) : [],
  };
}

export function evaluateSendPolicy(room: RoomSecurity, peer: PeerAddress | null, gate: GeoGate): { decision: SendCheck; geo: GeoAnnotation | null } {
  const decision = canSend(room);
  if (!gate.enabled || !gate.lists || !peer) return { decision, geo: null };
  return { decision, geo: annotateAddress(gate.lists, peer) };
}

function logToken(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}

export function formatGeoLabel(note: GeoAnnotation): string | null {
  const parts: string[] = [];
  if (note.country) parts.push(`geo_country=${logToken(note.country)}`);
  if (note.categories.length > 0) {
    parts.push(`geo_categories=${note.categories.map(logToken).join(",")}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export function annotateRedactedLog(line: string, peer: PeerAddress | null, gate: GeoGate): string {
  const redacted = redact(line);
  if (!gate.enabled || !gate.lists || !peer) return redacted;
  const label = formatGeoLabel(annotateAddress(gate.lists, peer));
  return label ? `${redacted} ${label}` : redacted;
}

export function tryLoadGeoDir(dir: string): GeoLists | null {
  try {
    const ipPath = path.join(dir, "geoip.dat");
    const sitePath = path.join(dir, "geosite.dat");
    if (!fs.existsSync(ipPath) || !fs.existsSync(sitePath)) return null;
    return loadGeoLists(fs.readFileSync(ipPath), fs.readFileSync(sitePath));
  } catch {
    return null;
  }
}
