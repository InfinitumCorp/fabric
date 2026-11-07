import { redact } from "../../core/src/redact.ts";

export interface RedactingLogger {
  trace(...msg: unknown[]): void;
  debug(...msg: unknown[]): void;
  info(...msg: unknown[]): void;
  warn(...msg: unknown[]): void;
  error(...msg: unknown[]): void;
  getChild(namespace: string): RedactingLogger;
}

export function redactLine(line: string): string {
  return redact(line).replace(
    /"?(password|access_token|refresh_token|body|key|ciphertext|session)"\s*:\s*"(?:\\.|[^"\\])*"/gi,
    '"$1":"[redacted]"',
  );
}

/** Debug, info, and trace are dropped. Warnings and errors are redacted before they reach the console. */
export function createRedactingLogger(write?: (level: "warn" | "error", line: string) => void): RedactingLogger {
  const emit = write ?? ((level: "warn" | "error", line: string) => {
    if (level === "warn") console.warn(line);
    else console.error(line);
  });
  const text = (msg: unknown[]) => redactLine(msg.map((part) => {
    if (typeof part === "string") return part;
    if (part instanceof Error) return `${part.name}:${part.message}`;
    return "[object]";
  }).join(" "));
  const logger: RedactingLogger = {
    trace() {},
    debug() {},
    info() {},
    warn(...msg: unknown[]) { emit("warn", text(msg)); },
    error(...msg: unknown[]) { emit("error", text(msg)); },
    getChild() { return logger; },
  };
  return logger;
}
