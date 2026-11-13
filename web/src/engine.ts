import type { Identity } from "../../core/src/conversation.ts";

export type SessionInfo = { userId: string; deviceId: string };
export type RoomSummary = { roomId: string; name: string; peer: string | null; invited: boolean };
export type ChatMessage = {
  id: string;
  mine: boolean;
  sender: string;
  body: string | null;
  utd: boolean;
  state: "sending" | "sent" | "failed";
};
export type PeerView = { encrypted: boolean | null; peer: string | null; identity: Identity; wasVerified: boolean };
export type VerificationView = {
  phase: "idle" | "requested" | "incoming" | "accepted" | "sas" | "done" | "cancelled" | "failed";
  other: string | null;
  emojis: { symbol: string; description: string }[];
};
export type StoredEvent = {
  type: string;
  algorithm: string | null;
  hasPlainBody: boolean;
  includes: (needle: string) => boolean;
};

export interface Engine {
  signIn(homeserver: string, username: string, password: string): Promise<SessionInfo>;
  logout(): Promise<void>;
  rooms(): Promise<RoomSummary[]>;
  createDm(userId: string): Promise<string>;
  join(roomId: string): Promise<void>;
  peerStatus(roomId: string): Promise<PeerView>;
  messages(roomId: string): Promise<ChatMessage[]>;
  open(roomId: string): Promise<void>;
  send(roomId: string, text: string): Promise<{ eventId: string }>;
  retry(roomId: string, eventId: string): Promise<void>;
  acknowledgeIdentityChange(roomId: string): Promise<void>;
  block(userId: string): Promise<void>;
  unblock(userId: string): Promise<void>;
  blocked(): Promise<string[]>;
  report(roomId: string, eventId: string): Promise<void>;
  ownDeviceVerified(): Promise<boolean>;
  ownTrust(): Promise<{ ready: boolean; crossSigningVerified: boolean; signedByOwner: boolean }>;
  verification(): VerificationView;
  verifyOwnDevice(): Promise<void>;
  verifyUser(userId: string, roomId: string): Promise<void>;
  verifyAccept(): Promise<void>;
  verifyConfirm(): Promise<void>;
  verifyMismatch(): Promise<void>;
  verifyCancel(): Promise<void>;
  verifyReset(): void;
  syncLabel(): string;
  pauseSync(): Promise<void>;
  resumeSync(): Promise<void>;
  publicMasterKey(): Promise<string | null>;
  serverEvent(roomId: string, eventId: string): Promise<StoredEvent>;
}
