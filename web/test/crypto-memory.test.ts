import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "matrix-js-sdk";
import { createRedactingLogger } from "../src/logger.ts";
import { createSessionStores } from "../src/stores.ts";

test("rust crypto initialises without indexedDB or localStorage", async () => {
  const touches: string[] = [];
  const storage = {
    getItem() {
      touches.push("get");
      return null;
    },
    setItem() {
      touches.push("set");
    },
    removeItem() {
      touches.push("remove");
    },
    clear() {
      touches.push("clear");
    },
    key() {
      return null;
    },
    length: 0,
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open(name: string) {
        touches.push(`open:${name}`);
        throw new Error("indexeddb_forbidden");
      },
      deleteDatabase(name: string) {
        touches.push(`delete:${name}`);
        throw new Error("indexeddb_forbidden");
      },
    },
  });

  const stores = createSessionStores();
  assert.equal((stores.store as unknown as { localStorage?: Storage }).localStorage, undefined);
  const client = createClient({
    baseUrl: "http://127.0.0.1:18408",
    userId: "@mem:localhost",
    deviceId: "MEMDEVICE",
    accessToken: "syt_not_a_real_token",
    store: stores.store,
    cryptoStore: stores.cryptoStore,
    disableVoip: true,
    verificationMethods: ["m.sas.v1"],
    logger: createRedactingLogger(() => {}),
  });
  await client.initRustCrypto({ useIndexedDB: false });
  client.stopClient();
  assert.deepEqual(touches, []);
});
