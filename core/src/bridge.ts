/**
 * Contract between the screens and the native Matrix module (spec section 3).
 * Keys, access tokens and passwords stay native; JavaScript only sees ids and error codes.
 * The native module is built in Stage 3. Until then only `unavailableBridge` exists,
 * and nothing in this package sends, stores or encrypts messages.
 */
export type Session = { userId: string; deviceId: string };

export type BridgeErrorCode = "store_locked" | "login_failed" | "bridge_unavailable";

export interface MatrixBridge {
  /** True only for a native module that has passed the Stage 3 spike checklist. */
  readonly encryptedMessaging: boolean;
  restore(homeserver: string): Promise<Session | null>;
  login(homeserver: string, username: string, password: string): Promise<Session>;
  logoutAndWipe(): Promise<void>;
}

export class BridgeUnavailableError extends Error {
  code: BridgeErrorCode = "bridge_unavailable";
  constructor() {
    super("The native Matrix module is not built yet");
  }
}

export const unavailableBridge: MatrixBridge = {
  encryptedMessaging: false,
  restore: async () => { throw new BridgeUnavailableError(); },
  login: async () => { throw new BridgeUnavailableError(); },
  logoutAndWipe: async () => { throw new BridgeUnavailableError(); },
};
