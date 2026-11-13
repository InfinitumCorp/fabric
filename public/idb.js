// IndexedDB key-value backend for the vault. IndexedDB can store CryptoKey objects
// (including non-extractable ones) via structured clone; localStorage cannot.

export function idbBackend(name) {
  let dbp = null;
  const open = () => new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const db = () => (dbp ??= open());

  return {
    async get(key) {
      const d = await db();
      return new Promise((resolve, reject) => {
        const r = d.transaction('kv').objectStore('kv').get(key);
        r.onsuccess = () => resolve(r.result ?? null);
        r.onerror = () => reject(r.error);
      });
    },
    async putMany(entries) {
      const d = await db();
      return new Promise((resolve, reject) => {
        // strict durability: a save that resolves has reached disk (it gates sending messages)
        const tx = d.transaction('kv', 'readwrite', { durability: 'strict' });
        const store = tx.objectStore('kv');
        for (const [k, v] of Object.entries(entries)) {
          if (v == null) store.delete(k); else store.put(v, k);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
  };
}
