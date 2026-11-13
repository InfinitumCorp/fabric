import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createClient, MemoryCryptoStore, MemoryStore } from "matrix-js-sdk";
import { createRedactingLogger } from "../src/logger.ts";
import { createEngine } from "../src/session.ts";

function loadServer(): { homeserver: string; secret: string } | null {
  const envPath = new URL("../.local/fixture.env", import.meta.url);
  const yamlPath = new URL("../.local/synapse/data/homeserver.yaml", import.meta.url);
  if (!existsSync(envPath) || !existsSync(yamlPath)) return null;
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  const secret = /^registration_shared_secret:\s*(.+)$/m.exec(readFileSync(yamlPath, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!env.HOMESERVER || !secret) return null;
  return { homeserver: env.HOMESERVER, secret };
}

async function registerUser(homeserver: string, secret: string): Promise<{ username: string; password: string }> {
  const username = `wb${randomBytes(3).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  const nonceResponse = await fetch(`${homeserver}/_synapse/admin/v1/register`);
  if (!nonceResponse.ok) throw new Error(`register_nonce_${nonceResponse.status}`);
  const { nonce } = await nonceResponse.json() as { nonce: string };
  const mac = createHmac("sha1", secret).update(`${nonce}\0${username}\0${password}\0notadmin`).digest("hex");
  const response = await fetch(`${homeserver}/_synapse/admin/v1/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, username, password, admin: false, mac }),
  });
  if (!response.ok) throw new Error(`register_${response.status}`);
  return { username, password };
}

const server = loadServer();
const skip = server ? false : "local Synapse fixture is absent; run web/scripts/synapse-fixture.sh";

async function waitFor(label: string, fn: () => Promise<boolean>, ms = 90_000) {
  const start = Date.now();
  let last = "not ready";
  while (Date.now() - start < ms) {
    try {
      if (await fn()) return;
      last = "false";
    } catch (err) {
      last = err instanceof Error ? err.name : "error";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout:${label}:${last}`);
}

test("two sdk clients exchange real ciphertext and refuse a changed identity", { skip, timeout: 300_000 }, async () => {
  const env = server!;
  assert.equal(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(env.homeserver), true);
  const aliceUser = await registerUser(env.homeserver, env.secret);
  const bobUser = await registerUser(env.homeserver, env.secret);
  const reports: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/report/") && init?.body) reports.push(String(init.body));
    return original(input, init as RequestInit);
  };
  const alice = createEngine();
  const bob = createEngine();
  try {
    const aliceSession = await alice.signIn(env.homeserver, aliceUser.username, aliceUser.password);
    const bobSession = await bob.signIn(env.homeserver, bobUser.username, bobUser.password);
    assert.match(aliceSession.userId, /^@/);
    assert.match(aliceSession.deviceId, /./);
    assert.equal(await alice.ownDeviceVerified(), true);
    const before = await alice.publicMasterKey();
    const aliceAgain = createEngine();
    await aliceAgain.signIn(env.homeserver, aliceUser.username, aliceUser.password);
    const after = await alice.publicMasterKey();
    assert.equal(before && after && before === after, true);
    assert.equal(await aliceAgain.ownDeviceVerified(), false);
    await aliceAgain.logout();

    const roomId = await alice.createDm(bobSession.userId);
    await waitFor("bob invite", async () => (await bob.rooms()).some((r) => r.roomId === roomId));
    await bob.join(roomId);
    await alice.open(roomId);
    await bob.open(roomId);
    await waitFor("identities", async () => {
      const a = await alice.peerStatus(roomId);
      const b = await bob.peerStatus(roomId);
      return a.identity === "unverified" && b.identity === "unverified";
    });
    const marker = `M${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const sent = await alice.send(roomId, marker);
    const stored = await alice.serverEvent(roomId, sent.eventId);
    assert.equal(stored.type, "m.room.encrypted");
    assert.equal(stored.algorithm, "m.megolm.v1.aes-sha2");
    assert.equal(stored.hasPlainBody, false);
    assert.equal(stored.includes(marker), false);
    await waitFor("bob decrypt", async () => (await bob.messages(roomId)).some((m) => m.body === marker && !m.utd));

    await alice.pauseSync();
    const marker2 = `N${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await bob.send(roomId, marker2);
    assert.equal((await alice.messages(roomId)).some((m) => m.body === marker2), false);
    await alice.resumeSync();
    await waitFor("catchup", async () => (await alice.messages(roomId)).some((m) => m.body === marker2 && !m.utd));

    await bob.block(aliceSession.userId);
    assert.deepEqual(await bob.blocked(), [aliceSession.userId]);
    await bob.unblock(aliceSession.userId);
    assert.deepEqual(await bob.blocked(), []);

    const incoming = (await bob.messages(roomId)).find((m) => m.body === marker);
    assert.ok(incoming);
    await bob.report(roomId, incoming.id);
    assert.equal(reports.length > 0, true);
    assert.equal(reports.some((body) => body.includes(marker)), false);
    assert.match(reports[0], /"score":-100/);
    assert.match(reports[0], /"reason":"Abuse"/);

    await resetPublishedIdentity(env.homeserver, bobUser.username, bobUser.password);
    await waitFor("identity change", async () => (await alice.peerStatus(roomId)).identity === "changed");
    await assert.rejects(alice.send(roomId, "blocked"), (err: { code?: string }) => err.code === "identity_changed");
    await alice.acknowledgeIdentityChange(roomId);
    await waitFor("ack", async () => (await alice.peerStatus(roomId)).identity !== "changed");
    const marker3 = `P${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const resent = await alice.send(roomId, marker3);
    const stored3 = await alice.serverEvent(roomId, resent.eventId);
    assert.equal(stored3.type, "m.room.encrypted");
    assert.equal(stored3.includes(marker3), false);

    await driveOwnDeviceSas(alice, aliceAgainLogin(env.homeserver, aliceUser.username, aliceUser.password));
  } finally {
    globalThis.fetch = original;
    await alice.logout().catch(() => {});
    await bob.logout().catch(() => {});
  }
});

async function aliceAgainLogin(homeserver: string, username: string, password: string) {
  const again = createEngine();
  await again.signIn(homeserver, username, password);
  return again;
}

async function driveOwnDeviceSas(existing: ReturnType<typeof createEngine>, nextPromise: Promise<ReturnType<typeof createEngine>>) {
  const next = await nextPromise;
  try {
    assert.equal(await existing.ownDeviceVerified(), true);
    assert.equal(await next.ownDeviceVerified(), false);
    await next.verifyOwnDevice();
    await waitFor("incoming sas", async () => existing.verification().phase === "incoming");
    await existing.verifyAccept();
    await waitFor("emoji", async () => existing.verification().phase === "sas" && next.verification().phase === "sas", 90_000);
    const a = existing.verification().emojis.map((e) => e.symbol).join();
    const b = next.verification().emojis.map((e) => e.symbol).join();
    assert.equal(a.length > 0 && a === b, true);
    await existing.verifyConfirm();
    await next.verifyConfirm();
    await waitFor("verified", async () => (await next.ownDeviceVerified()) === true, 60_000);
  } finally {
    await next.logout().catch(() => {});
  }
}

async function resetPublishedIdentity(homeserver: string, username: string, password: string) {
  const probe = createClient({
    baseUrl: homeserver,
    store: new MemoryStore(),
    cryptoStore: new MemoryCryptoStore(),
    disableVoip: true,
    logger: createRedactingLogger(),
  });
  const login = await probe.loginRequest({
    type: "m.login.password",
    identifier: { type: "m.id.user", user: username },
    password,
  });
  probe.stopClient();
  const client = createClient({
    baseUrl: homeserver,
    userId: login.user_id,
    deviceId: login.device_id,
    accessToken: login.access_token,
    store: new MemoryStore(),
    cryptoStore: new MemoryCryptoStore(),
    disableVoip: true,
    logger: createRedactingLogger(),
  });
  await client.initRustCrypto({ useIndexedDB: false });
  await client.startClient({ initialSyncLimit: 1 });
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("no_crypto");
  await crypto.bootstrapCrossSigning({
    setupNewCrossSigning: true,
    authUploadDeviceSigningKeys: async (makeRequest) => {
      await makeRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: login.user_id },
        password,
      });
    },
  });
  client.stopClient();
  await client.logout(true).catch(() => {});
  await client.clearStores().catch(() => {});
}
