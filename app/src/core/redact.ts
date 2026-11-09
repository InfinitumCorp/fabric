import { annotateLine } from "./geo.ts";

export function redact(
  line: string,
  env: { INFINITUM_GEO_ENABLED?: string; INFINITUM_GEO_DIR?: string } = process.env,
): string {
  const cleaned = line
    .replace(/@[a-zA-Z0-9._-]+:[a-zA-Z0-9.-]+/g, "[user]")
    .replace(/token=[^\s]+/g, "token=[redacted]")
    .replace(/Bearer\s+[^\s]+/g, "Bearer [redacted]")
    .replace(/body="[^"]*"/g, 'body="[redacted]"')
    .replace(/password=[^\s]+/gi, "password=[redacted]")
    .replace(/key=[^\s]+/gi, "key=[redacted]");
  return annotateLine(cleaned, env);
}
