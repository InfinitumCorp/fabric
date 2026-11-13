import { renderBody } from "../../core/src/rules.ts";
import { sendDecision, type Identity, type PeerStatus, type SendDecision } from "../../core/src/conversation.ts";

export class AppError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "AppError";
    this.code = code;
  }
}

export const PROTOTYPE_WARNING =
  "Limited prototype. Reloading this page creates a new device. Access to messages from before this visit is not guaranteed. Closing this page does not reliably revoke the server session. Use Sign out to end it. The password, access token, and encryption keys stay in this tab's memory only. This page is not a phone keystore and does not block screenshots or extensions.";

export const REVENUE_PLAN = "Not connected. Plans and upgrades are not available in this build. Personal messaging is free.";
export const REVENUE_DATA =
  "Not connected. No data is shared and there are no earnings to show. Messaging does not depend on this. This build cannot authorize data sharing.";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Returns the origin of a loopback homeserver, or throws `bad_server`. */
export function assertLocalHomeserver(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError("bad_server");
  }
  if (url.username || url.password || url.search || url.hash) throw new AppError("bad_server");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AppError("bad_server");
  if (!LOOPBACK.has(url.hostname)) throw new AppError("bad_server");
  if (url.pathname !== "/" && url.pathname !== "") throw new AppError("bad_server");
  const port = url.port ? `:${url.port}` : "";
  const host = url.hostname === "::1" ? "[::1]" : url.hostname;
  return `${url.protocol}//${host}${port}`;
}

export function assertSecureContext(isSecure: boolean): void {
  if (!isSecure) throw new AppError("insecure_context");
}

export function mapIdentity(status: { known: boolean; needsUserApproval: boolean; crossSigningVerified: boolean }): Identity {
  if (!status.known) return "unknown";
  if (status.needsUserApproval) return "changed";
  if (status.crossSigningVerified) return "verified";
  return "unverified";
}

export function decideSend(status: PeerStatus): SendDecision {
  return sendDecision(status);
}

export function peerUserId(myId: string, memberIds: string[], inviter: string | null, membership: "join" | "invite"): string | null {
  if (membership === "invite") return inviter;
  const others = memberIds.filter((id) => id !== myId);
  return others.length === 1 ? others[0] : null;
}

/** Previously verified identities are withdrawn. A first identity change is pinned. Neither runs by itself. */
export function acknowledgementCall(wasVerified: boolean): "withdraw" | "pin" {
  return wasVerified ? "withdraw" : "pin";
}

export function messageText(utd: boolean, body: string | null): string {
  if (utd || body === null) return renderBody({ kind: "undecryptable" });
  return renderBody({ kind: "text", body });
}

export function mapSendState(status: string | null): "sending" | "sent" | "failed" {
  if (status === null || status === "sent") return "sent";
  if (status === "not_sent" || status === "cancelled") return "failed";
  return "sending";
}

export function reportRequest(roomId: string, eventId: string): { path: string; body: { score: number; reason: string } } {
  if (!roomId.startsWith("!") || !eventId.startsWith("$") || eventId.length > 512) throw new AppError("bad_input");
  return {
    path: `/rooms/${encodeURIComponent(roomId)}/report/${encodeURIComponent(eventId)}`,
    body: { score: -100, reason: "Abuse" },
  };
}
