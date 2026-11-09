import { MemoryCryptoStore, MemoryStore } from "matrix-js-sdk";

/** Sync data and legacy crypto data stay in memory. No browser storage is attached. */
export function createSessionStores(): { store: MemoryStore; cryptoStore: MemoryCryptoStore } {
  return {
    store: new MemoryStore(),
    cryptoStore: new MemoryCryptoStore(),
  };
}
