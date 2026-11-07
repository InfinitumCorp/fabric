/**
 * Creates cross-signing keys only when the server has none.
 * `setupNewCrossSigning` is never set true: an existing identity is left unchanged.
 */
export async function ensureOwnIdentity(args: {
  hasCrossSigningKeys: () => Promise<boolean>;
  bootstrap: (opts: { setupNewCrossSigning?: boolean }) => Promise<void>;
}): Promise<"created" | "existing"> {
  const has = await args.hasCrossSigningKeys();
  if (has) return "existing";
  await args.bootstrap({ setupNewCrossSigning: false });
  return "created";
}
