/** Conversation rules shared by every platform. Native code enforces the same rules again before sending. */
export type Identity = "verified" | "unverified" | "changed" | "unknown";
export type PeerStatus = { encrypted: boolean | null; peer: string | null; identity: Identity };
export type SendDecision =
  | { ok: true }
  | { ok: false; reason: "not_encrypted" | "encryption_unknown" | "identity_changed" | "identity_unknown" };

export function sendDecision(s: PeerStatus): SendDecision {
  if (s.encrypted === false) return { ok: false, reason: "not_encrypted" };
  if (s.encrypted !== true) return { ok: false, reason: "encryption_unknown" };
  if (!s.peer || s.identity === "unknown") return { ok: false, reason: "identity_unknown" };
  if (s.identity === "changed") return { ok: false, reason: "identity_changed" };
  return { ok: true };
}

export function trustLabel(i: Identity): string {
  return { verified: "Verified", unverified: "Not verified", changed: "Identity changed", unknown: "Identity unknown" }[i];
}

export const refusalText: Record<Exclude<SendDecision, { ok: true }>["reason"], string> = {
  not_encrypted: "This conversation is not encrypted. Sending is disabled.",
  encryption_unknown: "Encryption state is not known yet. Sending is disabled.",
  identity_changed: "This contact's identity changed. Acknowledge the change before sending.",
  identity_unknown: "This contact's encryption identity is not available yet. Sending is disabled.",
};

export function isValidUserId(s: string): boolean {
  return /^@[a-z0-9._=\-/+]+:[A-Za-z0-9.\-]+(:[0-9]{1,5})?$/.test(s);
}
