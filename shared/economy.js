// FABRIC opt-in data economy: purposes, contribution weights and the 70/30 revenue split.
// Only metadata counts (never message contents) feed contribution weights.

export const USER_SHARE = 0.7;

export const PURPOSES = {
  usage: {
    label: 'Usage analytics',
    detail: 'Aggregate counts of messages and calls you send. Never contents, never recipients.',
    weight: 1,
  },
  network: {
    label: 'Network quality',
    detail: 'Delivery latency and transport type (internet, Wi-Fi, ÆTHER mesh) per message.',
    weight: 0.5,
  },
  research: {
    label: 'Product research',
    detail: 'Feature usage (summaries, translation, smart replies) to inform the roadmap.',
    weight: 0.25,
  },
};

export function defaultConsent() {
  return Object.fromEntries(Object.keys(PURPOSES).map((k) => [k, false]));
}

/** Contribution weight for one user given their consent and metadata counters. */
export function contributionWeight(consent, counters) {
  let w = 0;
  for (const [key, p] of Object.entries(PURPOSES)) {
    if (consent?.[key]) w += p.weight * (counters?.[key] || 0);
  }
  return w;
}

const toCents = (usd) => Math.round(usd * 100);

/**
 * Split eligible net revenue. Returns cents-exact allocations (largest-remainder rounding)
 * so the user pool always sums to exactly 70% of revenue.
 * @param {number} revenueUsd eligible net brokerage revenue
 * @param {Record<string, number>} weights handle -> contribution weight (0 = not participating)
 */
export function allocate(revenueUsd, weights) {
  const revenueCents = toCents(revenueUsd);
  const poolCents = Math.round(revenueCents * USER_SHARE);
  const infinitumCents = revenueCents - poolCents;
  const participants = Object.entries(weights).filter(([, w]) => w > 0);
  const total = participants.reduce((s, [, w]) => s + w, 0);

  const allocations = {};
  if (total > 0) {
    const raw = participants.map(([h, w]) => {
      const exact = (poolCents * w) / total;
      return { h, floor: Math.floor(exact), rem: exact - Math.floor(exact) };
    });
    let left = poolCents - raw.reduce((s, r) => s + r.floor, 0);
    raw.sort((a, b) => b.rem - a.rem || a.h.localeCompare(b.h));
    for (const r of raw) {
      allocations[r.h] = r.floor + (left > 0 ? 1 : 0);
      if (left > 0) left--;
    }
  }

  return {
    revenueCents,
    poolCents: total > 0 ? poolCents : 0,
    infinitumCents: total > 0 ? infinitumCents : revenueCents,
    participants: participants.length,
    allocations, // handle -> cents
  };
}
