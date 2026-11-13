import {
  ClientEvent,
  createClient,
  EventStatus,
  EventType,
  KnownMembership,
  MsgType,
  Preset,
  SyncState,
  Visibility,
  type MatrixClient,
  type Room,
} from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/index.js";
import { logger as sdkLogger } from "matrix-js-sdk/lib/logger.js";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import { isValidUserId } from "../../core/src/conversation.ts";
import { UsageCounter } from "../../core/src/usage.ts";
import { consentGranted } from "./consent.ts";
import type { ChatMessage, Engine, PeerView, RoomSummary, SessionInfo, StoredEvent, VerificationView } from "./engine.ts";
import { ensureOwnIdentity } from "./identity.ts";
import { createRedactingLogger, type RedactingLogger } from "./logger.ts";
import {
  acknowledgementCall,
  AppError,
  decideSend,
  mapIdentity,
  mapSendState,
  peerUserId,
  reportRequest,
  assertLocalHomeserver,
} from "./policy.ts";
import { shutdownSession } from "./shutdown.ts";
import { createSessionStores } from "./stores.ts";
import { SasController } from "./verify.ts";

const DEVICE_NAME = "FabriC++ browser";

const sdkSink = createRedactingLogger();
const globalSdkLogger = sdkLogger as typeof sdkLogger & {
  methodFactory: (methodName: string, level: number, name: string | symbol) => (...msg: unknown[]) => void;
  setLevel: (level: string, persist?: boolean) => void;
  rebuild: () => void;
};
globalSdkLogger.methodFactory = (methodName) => (...msg) => {
  if (methodName === "warn" || methodName === "error") sdkSink.warn(...msg);
};
globalSdkLogger.setLevel("warn", false);
globalSdkLogger.rebuild();

export function createEngine(): Engine {
  return new BrowserEngine();
}

class BrowserEngine implements Engine {
  private client: MatrixClient | null = null;
  private readonly sas = new SasController();
  private sync: SyncState | null = null;
  private readonly logger: RedactingLogger = createRedactingLogger();
  private readonly usage = new UsageCounter(consentGranted);
  private readonly seen = new Set<string>();

  async signIn(homeserver: string, username: string, password: string): Promise<SessionInfo> {
    if (this.client) throw new AppError("already_signed_in");
    const baseUrl = assertLocalHomeserver(homeserver);
    const user = username.trim();
    if (!user || user.length > 255 || /[\r\n]/.test(user)) throw new AppError("bad_input");
    const probe = this.makeClient(baseUrl);
    let login;
    try {
      login = await probe.loginRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user },
        password,
        initial_device_display_name: DEVICE_NAME,
      });
    } catch (err) {
      this.logger.error("sign-in failed", err instanceof Error ? err.message : "error");
      throw new AppError("login_failed");
    } finally {
      probe.stopClient();
    }
    if (!login.access_token || !login.user_id || !login.device_id) throw new AppError("login_failed");
    const client = this.makeClient(baseUrl, {
      userId: login.user_id,
      deviceId: login.device_id,
      accessToken: login.access_token,
    });
    this.client = client;
    try {
      await client.initRustCrypto({ useIndexedDB: false });
      client.on(CryptoEvent.VerificationRequestReceived, (request) => this.sas.onIncoming(request));
      client.on(ClientEvent.Sync, (state) => { this.sync = state; });
      await client.startClient({ initialSyncLimit: 30 });
      await this.waitPrepared(client);
      const crypto = this.crypto();
      await ensureOwnIdentity({
        hasCrossSigningKeys: async () => {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            if (await crypto.userHasCrossSigningKeys(login.user_id, true)) return true;
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
          return false;
        },
        bootstrap: () => crypto.bootstrapCrossSigning({
          setupNewCrossSigning: false,
          authUploadDeviceSigningKeys: async (makeRequest) => {
            const submit = async (auth: Parameters<typeof makeRequest>[0]): Promise<void> => {
              try {
                await makeRequest(auth);
              } catch (err) {
                const data = (err as { data?: { session?: string; flows?: unknown } }).data;
                if (auth === null && data?.session && data.flows) {
                  await submit({
                    type: "m.login.password",
                    identifier: { type: "m.id.user", user: login.user_id },
                    password,
                    session: data.session,
                  });
                  return;
                }
                throw err;
              }
            };
            await submit(null);
          },
        }),
      });
    } catch (err) {
      this.logger.error("session start failed", err instanceof Error ? err.message : "error");
      await shutdownSession(client).catch(() => client.stopClient());
      this.client = null;
      throw err instanceof AppError ? err : new AppError("login_failed");
    }
    return { userId: login.user_id, deviceId: login.device_id };
  }

  async logout(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.sync = null;
    this.sas.reset();
    if (!client) return;
    await shutdownSession(client);
  }

  async rooms(): Promise<RoomSummary[]> {
    return this.require().getRooms().flatMap((room) => {
      const membership = room.getMyMembership();
      if (membership !== KnownMembership.Join && membership !== KnownMembership.Invite) return [];
      const peer = this.peerOf(room);
      return [{
        roomId: room.roomId,
        name: peer ?? room.name ?? room.roomId,
        peer,
        invited: membership === KnownMembership.Invite,
      }];
    });
  }

  async createDm(userId: string): Promise<string> {
    if (!isValidUserId(userId) || userId === this.require().getUserId()) throw new AppError("bad_input");
    try {
      const created = await this.require().createRoom({
        invite: [userId],
        is_direct: true,
        visibility: Visibility.Private,
        preset: Preset.TrustedPrivateChat,
        initial_state: [{
          type: EventType.RoomEncryption,
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        }],
      });
      return created.room_id;
    } catch (err) {
      this.logger.error("create failed", err instanceof Error ? err.message : "error");
      throw new AppError("create_failed");
    }
  }

  async join(roomId: string): Promise<void> {
    const client = this.require();
    const room = this.room(roomId);
    const membership = room.getMyMembership();
    if (membership !== KnownMembership.Invite && membership !== KnownMembership.Join) throw new AppError("no_room");
    if (membership === KnownMembership.Invite) await client.joinRoom(roomId);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (this.room(roomId).hasEncryptionStateEvent()) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await client.leave(roomId).catch(() => {});
    throw new AppError("not_encrypted");
  }

  async open(roomId: string): Promise<void> {
    const room = this.room(roomId);
    if (!room.hasEncryptionStateEvent()) throw new AppError(this.encryption(room) === null ? "encryption_unknown" : "not_encrypted");
    await this.require().scrollback(room, 30).catch(() => {});
  }

  async peerStatus(roomId: string): Promise<PeerView> {
    const room = this.room(roomId);
    const encrypted = this.encryption(room);
    const peer = this.peerOf(room);
    if (!peer) return { encrypted, peer: null, identity: "unknown", wasVerified: false };
    const status = await this.crypto().getUserVerificationStatus(peer);
    return {
      encrypted,
      peer,
      identity: mapIdentity({
        known: status.known,
        needsUserApproval: status.needsUserApproval,
        crossSigningVerified: status.isCrossSigningVerified(),
      }),
      wasVerified: status.wasCrossSigningVerified(),
    };
  }

  async messages(roomId: string): Promise<ChatMessage[]> {
    const client = this.require();
    const room = this.room(roomId);
    const mineId = client.getUserId();
    const out: ChatMessage[] = [];
    for (const event of room.getLiveTimeline().getEvents()) {
      const id = event.getId() ?? event.getTxnId() ?? "";
      const sender = event.getSender() ?? "";
      const mine = sender === mineId;
      const pending = event.status !== null;
      if (event.isDecryptionFailure()) {
        out.push({ id, mine, sender, body: null, utd: true, state: mapSendState(event.status) });
        continue;
      }
      if (event.getType() !== EventType.RoomMessage) continue;
      if (!event.isEncrypted() && !pending) continue;
      const content = event.getContent();
      if (content.msgtype !== MsgType.Text) continue;
      const body = typeof content.body === "string" ? content.body : null;
      if (!mine && id && !this.seen.has(id)) {
        this.seen.add(id);
        this.usage.onReceived();
      }
      out.push({
        id,
        mine,
        sender,
        body: event.isDecryptionFailure() ? null : body,
        utd: body === null,
        state: mapSendState(event.status),
      });
    }
    return out;
  }

  async send(roomId: string, text: string): Promise<{ eventId: string }> {
    if (text.length === 0 || text.length > 8000) throw new AppError("bad_text");
    const decision = decideSend(await this.peerStatus(roomId));
    if (!decision.ok) throw new AppError(decision.reason);
    const room = this.room(roomId);
    if (!room.hasEncryptionStateEvent()) throw new AppError("not_encrypted");
    try {
      const sent = await this.require().sendEvent(roomId, EventType.RoomMessage, { msgtype: MsgType.Text, body: text });
      this.usage.onSent();
      return { eventId: sent.event_id };
    } catch (err) {
      this.logger.error("send failed", err instanceof Error ? err.message : "error");
      throw err instanceof AppError ? err : new AppError("send_failed");
    }
  }

  async retry(roomId: string, eventId: string): Promise<void> {
    const decision = decideSend(await this.peerStatus(roomId));
    if (!decision.ok) throw new AppError(decision.reason);
    const room = this.room(roomId);
    const pending = room.getPendingEvents().find((event) => event.getId() === eventId || event.getTxnId() === eventId);
    if (!pending || pending.status !== EventStatus.NOT_SENT) throw new AppError("send_failed");
    await this.require().resendEvent(pending, room);
  }

  async acknowledgeIdentityChange(roomId: string): Promise<void> {
    const status = await this.peerStatus(roomId);
    if (status.identity !== "changed" || !status.peer) throw new AppError(status.peer ? "bad_input" : "identity_unknown");
    const crypto = this.crypto();
    if (acknowledgementCall(status.wasVerified) === "withdraw") await crypto.withdrawVerificationRequirement(status.peer);
    else await crypto.pinCurrentUserIdentity(status.peer);
  }

  async block(userId: string): Promise<void> {
    if (!isValidUserId(userId)) throw new AppError("bad_input");
    const client = this.require();
    const current = client.getIgnoredUsers();
    if (!current.includes(userId)) await client.setIgnoredUsers([...current, userId]);
  }

  async unblock(userId: string): Promise<void> {
    const client = this.require();
    await client.setIgnoredUsers(client.getIgnoredUsers().filter((id) => id !== userId));
  }

  async blocked(): Promise<string[]> {
    return this.require().getIgnoredUsers();
  }

  async report(roomId: string, eventId: string): Promise<void> {
    const request = reportRequest(roomId, eventId);
    try {
      await this.require().reportEvent(roomId, eventId, request.body.score, request.body.reason);
    } catch (err) {
      this.logger.error("report failed", err instanceof Error ? err.message : "error");
      throw new AppError("report_failed");
    }
  }

  async ownTrust(): Promise<{ ready: boolean; crossSigningVerified: boolean; signedByOwner: boolean }> {
    const client = this.require();
    const userId = client.getUserId();
    const deviceId = client.getDeviceId();
    if (!userId || !deviceId) return { ready: false, crossSigningVerified: false, signedByOwner: false };
    const crypto = this.crypto();
    const ready = await crypto.isCrossSigningReady();
    const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
    return {
      ready,
      crossSigningVerified: status?.crossSigningVerified === true,
      signedByOwner: status?.signedByOwner === true,
    };
  }

  async ownDeviceVerified(): Promise<boolean> {
    const client = this.require();
    const userId = client.getUserId();
    const deviceId = client.getDeviceId();
    if (!userId || !deviceId) return false;
    const crypto = this.crypto();
    const ready = await crypto.isCrossSigningReady();
    const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
    return ready && status?.crossSigningVerified === true;
  }

  verification(): VerificationView {
    return this.sas.view();
  }

  async verifyOwnDevice(): Promise<void> {
    if (await this.ownDeviceVerified()) throw new AppError("already_verified");
    this.sas.bindOutgoing(await this.crypto().requestOwnUserVerification());
  }

  async verifyUser(userId: string, roomId: string): Promise<void> {
    if (!(await this.ownDeviceVerified())) throw new AppError("own_device_unverified");
    if (!isValidUserId(userId)) throw new AppError("bad_input");
    this.room(roomId);
    this.sas.bindOutgoing(await this.crypto().requestVerificationDM(userId, roomId));
  }

  async verifyAccept(): Promise<void> {
    await this.sas.accept(await this.ownDeviceVerified());
  }

  async verifyConfirm(): Promise<void> {
    await this.sas.confirm();
  }

  verifyMismatch(): Promise<void> {
    this.sas.mismatch();
    return Promise.resolve();
  }

  async verifyCancel(): Promise<void> {
    await this.sas.cancel();
  }

  verifyReset(): void {
    this.sas.reset();
  }

  syncLabel(): string {
    switch (this.sync) {
      case SyncState.Prepared:
      case SyncState.Syncing:
        return "Connected";
      case SyncState.Catchup:
        return "Catching up";
      case SyncState.Reconnecting:
        return "Reconnecting";
      case SyncState.Error:
        return "Connection interrupted";
      default:
        return "Connecting";
    }
  }

  async pauseSync(): Promise<void> {
    // Stop only the sync loop. stopClient() also stops the Rust crypto stack, and that stack cannot be restarted.
    const client = this.require() as MatrixClient & { syncApi?: { stop: () => void } };
    client.syncApi?.stop();
    client.syncApi = undefined;
    client.clientRunning = false;
    this.sync = SyncState.Stopped;
  }

  async resumeSync(): Promise<void> {
    await this.require().startClient({ initialSyncLimit: 30 });
  }

  async publicMasterKey(): Promise<string | null> {
    const client = this.require();
    const userId = client.getUserId();
    const token = client.getAccessToken();
    if (!userId || !token) return null;
    const response = await fetch(`${client.getHomeserverUrl()}/_matrix/client/v3/keys/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device_keys: { [userId]: [] } }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { master_keys?: Record<string, { keys?: Record<string, string> }> };
    const value = Object.values(data.master_keys?.[userId]?.keys ?? {})[0];
    return typeof value === "string" ? value : null;
  }

  async serverEvent(roomId: string, eventId: string): Promise<StoredEvent> {
    const client = this.require();
    const token = client.getAccessToken();
    if (!token) throw new AppError("not_signed_in");
    const response = await fetch(
      `${client.getHomeserverUrl()}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new AppError("send_failed");
    const raw = await response.text();
    const parsed = JSON.parse(raw) as { type?: string; content?: { algorithm?: string; body?: unknown } };
    return {
      type: parsed.type ?? "",
      algorithm: typeof parsed.content?.algorithm === "string" ? parsed.content.algorithm : null,
      hasPlainBody: typeof parsed.content?.body === "string",
      includes: (needle: string) => raw.includes(needle),
    };
  }

  private makeClient(baseUrl: string, auth?: { userId: string; deviceId: string; accessToken: string }): MatrixClient {
    const stores = createSessionStores();
    return createClient({
      baseUrl,
      userId: auth?.userId,
      deviceId: auth?.deviceId,
      accessToken: auth?.accessToken,
      store: stores.store,
      cryptoStore: stores.cryptoStore,
      disableVoip: true,
      verificationMethods: [VerificationMethod.Sas],
      logger: this.logger,
    });
  }

  private require(): MatrixClient {
    if (!this.client) throw new AppError("not_signed_in");
    return this.client;
  }

  private crypto() {
    const crypto = this.require().getCrypto();
    if (!crypto) throw new AppError("verification_unavailable");
    return crypto;
  }

  private room(roomId: string): Room {
    const room = this.require().getRoom(roomId);
    if (!room) throw new AppError("no_room");
    return room;
  }

  private peerOf(room: Room): string | null {
    const me = this.require().getUserId();
    if (!me) return null;
    if (room.getMyMembership() === KnownMembership.Invite) {
      return peerUserId(me, [], room.getDMInviter() ?? null, "invite");
    }
    const ids = room.getMembers()
      .filter((member) => member.membership === KnownMembership.Join || member.membership === KnownMembership.Invite)
      .map((member) => member.userId);
    return peerUserId(me, ids, null, "join");
  }

  private encryption(room: Room): boolean | null {
    if (room.hasEncryptionStateEvent()) return true;
    return this.require().isInitialSyncComplete() ? false : null;
  }

  private waitPrepared(client: MatrixClient): Promise<void> {
    if (client.getSyncState() === SyncState.Prepared || client.isInitialSyncComplete()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.removeListener(ClientEvent.Sync, onSync);
        reject(new AppError("sync_timeout"));
      }, 45_000);
      const onSync = (state: SyncState) => {
        if (state !== SyncState.Prepared) return;
        clearTimeout(timer);
        client.removeListener(ClientEvent.Sync, onSync);
        resolve();
      };
      client.on(ClientEvent.Sync, onSync);
    });
  }
}
