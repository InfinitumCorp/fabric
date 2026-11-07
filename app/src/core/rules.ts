export type RoomSecurity = {
  encryption: "on" | "off" | "unknown";
  pendingIdentityChange: boolean;
};

export type SendCheck = { ok: true } | { ok: false; reason: "not_encrypted" | "encryption_unknown" | "identity_changed" };

export type MessageView = { kind: "text"; body: string } | { kind: "undecryptable" };

export type SendStatus = "sending" | "sent" | "failed";

export function canSend(r: RoomSecurity): SendCheck {
  if (r.encryption === "off") return { ok: false, reason: "not_encrypted" };
  if (r.encryption === "unknown") return { ok: false, reason: "encryption_unknown" };
  if (r.pendingIdentityChange) return { ok: false, reason: "identity_changed" };
  return { ok: true };
}

export function renderBody(m: MessageView): string {
  return m.kind === "text" ? m.body : "Unable to decrypt";
}

export function nextStatus(s: SendStatus, e: "ack" | "error" | "retry"): SendStatus {
  if (s === "sending" && e === "ack") return "sent";
  if (s === "sending" && e === "error") return "failed";
  if (s === "failed" && e === "retry") return "sending";
  return s;
}
