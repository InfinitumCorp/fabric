import { NativeModule, requireOptionalNativeModule } from 'expo';

export type Session = { userId: string; deviceId: string };
export type RoomSummary = { roomId: string; name: string; peer: string | null; invited: boolean };
export type PeerStatusNative = { encrypted: boolean | null; peer: string | null; identity: 'verified' | 'unverified' | 'changed' | 'unknown' };
export type VerificationState = { phase: 'idle' | 'requested' | 'incoming' | 'accepted' | 'sas' | 'done' | 'cancelled' | 'failed'; other: string | null; emojis: { symbol: string; description: string }[] };
export type Message = { id: string; mine: boolean; sender: string; body: string | null; utd: boolean; state: 'sending' | 'sent' | 'failed'; ts: number };

/** Native Matrix bridge. Keys and access tokens stay native; errors arrive as codes only. */
declare class FabricMatrixModule extends NativeModule<{}> {
  encryptedMessaging: boolean;
  deviceVerification: boolean;
  /** True only in the compile-time diagnostic screenshot build. */
  diagnosticBuild: boolean;
  ownDeviceVerified(): Promise<boolean>;
  /** Ask another signed-in, trusted device of this account to verify this one (SAS). Never resets identity. */
  verifyOwnDevice(): Promise<void>;
  restore(hs: string): Promise<Session | null>;
  /** Opens the native sign-in screen. The password is entered and used natively; JS gets ids or null. */
  signIn(hs: string): Promise<Session | null>;
  logoutAndWipe(): Promise<void>;
  startSync(): Promise<void>;
  rooms(): Promise<RoomSummary[]>;
  createDm(userId: string): Promise<string>;
  join(roomId: string): Promise<void>;
  peerStatus(roomId: string): Promise<PeerStatusNative>;
  acknowledgeIdentityChange(roomId: string): Promise<void>;
  open(roomId: string): Promise<void>;
  messages(roomId: string): Promise<Message[]>;
  send(roomId: string, text: string): Promise<void>;
  block(userId: string): Promise<void>;
  unblock(userId: string): Promise<void>;
  blocked(): Promise<string[]>;
  /** Sends event id, room id and the reason text to the homeserver admins. Only after explicit consent. */
  report(roomId: string, eventId: string, reason: string): Promise<void>;
  verificationState(): Promise<VerificationState>;
  verifyUser(userId: string): Promise<void>;
  verifyAccept(): Promise<void>;
  verifyConfirm(): Promise<void>;
  verifyMismatch(): Promise<void>;
  verifyCancel(): Promise<void>;
  verifyReset(): Promise<void>;
}

/** Null when the native module is missing (e.g. web); callers must then offer no messaging. */
export default requireOptionalNativeModule<FabricMatrixModule>('FabricMatrix');
