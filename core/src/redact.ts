export function redact(line: string): string {
  return line
    .replace(/@[A-Za-z0-9._=\-/]+:[A-Za-z0-9.\-]+/g, "[user]")
    .replace(/\b(syt|syr|mat)_[A-Za-z0-9_\-]+/g, "[token]")
    .replace(/Bearer\s+\S+/gi, "Bearer [token]")
    .replace(/(body|password|key)=("[^"]*"|\S+)/gi, "$1=[redacted]");
}
