// FIRM Suite for the FabriC++ app: FIRM (settlement token), FIRM Wallet (firmwallet.app) and
// Firmament Network (CPO, firmnetwork.app). Same registry values as the web embed in
// infinitum-nexus/packages/firm/suite and the firmwallet.app token table ($FAB on Solana).

export const FIRM_WALLET_URL = "https://firmwallet.app";
export const FIRMAMENT_URL = "https://firmnetwork.app";

export interface FirmWallet {
  address: string;
  balances: Record<string, string>;
}

export type FirmState =
  | { kind: "early" }
  | { kind: "wallet"; wallet: FirmWallet };

export const FAB_TOKEN = { ticker: "$FAB", network: "Solana" } as const;
export const FIRM_TOKEN = { ticker: "$FIRM", network: "Solana (CPO) → Ethereum" } as const;

export function firmLinks(product = "fabric") {
  const ref = encodeURIComponent(product);
  return { wallet: `${FIRM_WALLET_URL}/?ref=${ref}`, network: `${FIRMAMENT_URL}/?ref=${ref}` };
}

/** Accept only a real wallet (address plus ticker-shaped balances); anything else means early access. */
export function firmState(data: unknown): FirmState {
  if (!data || typeof data !== "object") return { kind: "early" };
  const { address, balances } = data as { address?: unknown; balances?: unknown };
  if (typeof address !== "string" || !address) return { kind: "early" };
  const clean: Record<string, string> = {};
  if (balances && typeof balances === "object") {
    for (const [asset, amount] of Object.entries(balances as Record<string, unknown>)) {
      if (/^[A-Z0-9]{2,10}$/.test(asset)) clean[asset] = String(amount);
    }
  }
  return { kind: "wallet", wallet: { address, balances: clean } };
}

export function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}
