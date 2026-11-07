async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Stop the sync loop first so a long-poll cannot stall the logout request,
 * then ask the server to revoke the session, then drop in-memory stores.
 */
export async function shutdownSession(client: {
  logout: (stop?: boolean) => Promise<unknown>;
  stopClient: () => void;
  clearStores: () => Promise<void>;
}): Promise<void> {
  client.stopClient();
  try {
    await within(15_000, client.logout(false));
  } catch {
    // The server session may still exist. Local stores are cleared either way.
  }
  try {
    await within(5_000, client.clearStores());
  } catch {
    // A store that cannot be cleared is already out of this page once the client is dropped.
  }
}
