import { NativeModule, requireOptionalNativeModule } from 'expo';

export type Session = { userId: string; deviceId: string };
export type RoomSummary = { roomId: string; name: string; peer: string | null; invited: boolean };
export type PeerStatusNative = { encrypted: boolean | null; peer: string | null; identity: 'verified' | 'unverified' | 'changed' | 'unknown' };
export type Message = { id: string; mine: boolean; sender: string; body: string | null; utd: boolean; state: 'sending' | 'sent' | 'failed'; ts: number };

/** Native Matrix bridge. Keys and access tokens stay native; errors arrive as codes only. */
declare class FabricMatrixModule extends NativeModule<{}> {
  encryptedMessaging: boolean;
  deviceVerification: boolean;
  restore(hs: string): Promise<Session | null>;
  login(hs: string, user: string, password: string): Promise<Session>;
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
}

/** Null when the native module is missing (e.g. web); callers must then offer no messaging. */
export default requireOptionalNativeModule<FabricMatrixModule>('FabricMatrix');
