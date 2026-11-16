// Token-bucket rate limits for the relay. All in memory: limits reset on restart, which is fine
// for abuse control (they are not a billing mechanism).

export class Buckets {
  /**
   * @param {number} capacity  burst size
   * @param {number} perSecond refill rate
   */
  constructor(capacity, perSecond, { now = () => Date.now() } = {}) {
    Object.assign(this, { capacity, perSecond, now });
    this.map = new Map(); // key -> { tokens, at }
  }

  /** Take `cost` tokens for `key`. Returns 0 when allowed, else seconds until it would be. */
  take(key, cost = 1) {
    const t = this.now();
    let b = this.map.get(key);
    if (!b) { b = { tokens: this.capacity, at: t }; this.map.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.perSecond);
    b.at = t;
    if (b.tokens >= cost) { b.tokens -= cost; return 0; }
    return Math.ceil((cost - b.tokens) / this.perSecond);
  }

  /** Drop buckets that have refilled completely (they carry no state). */
  sweep() {
    const t = this.now();
    for (const [k, b] of this.map) {
      if (b.tokens + ((t - b.at) / 1000) * this.perSecond >= this.capacity) this.map.delete(k);
    }
  }
}

const per = (n, seconds) => n / seconds;

/** Default limits. Generous for real use; tight enough that abuse is slow and visible. */
export function defaultLimits(opts = {}) {
  const b = (cap, rate) => new Buckets(cap, rate, opts);
  return {
    connectIp: b(30, per(30, 60)),          // new WebSocket connections per IP
    httpIp: b(120, per(120, 60)),           // API requests per IP (static files are not counted)
    registerIp: b(20, per(20, 60)),         // register attempts per IP
    preRegisterIp: b(30, per(30, 60)),      // lookups / mailbox use before registering, per IP
    message: b(200, 50),                    // any WebSocket message, per connection
    send: b(120, 20),                       // envelope copies per device (fan-out to 6 + sync copies)
    lookup: b(60, per(60, 60)),             // directory lookups per device
    bundle: b(30, per(30, 60)),             // prekey bundles fetched, per requesting device
    opkTarget: b(20, per(20, 3600)),        // one-time prekeys handed out per target device
    opkPair: b(2, per(1, 600)),             // one-time prekeys per (requester, target) pair
    mailbox: b(20, per(20, 60)),            // link mailbox messages per connection
    misc: b(30, per(30, 60)),               // consent, feature, account, devices, prekey uploads
    sfu: b(120, 4),                         // large-call messages (joins, answers, speaker focus)
    anonIp: b(120, per(120, 60)),           // lookups and bundles over unregistered (sealed sender) sockets, per IP
    sealedIp: b(240, 20),                   // sealed envelopes per IP
    sealedTarget: b(300, 5),                // sealed envelopes per recipient device
    tally: b(10, per(10, 3600)),            // self-reported message counts for revenue share, per device
    cidIp: b(20, per(20, 600)),             // Cumulus://ID sign-ins started or finished, per IP
    spaces: b(120, 2),                      // large group and channel actions (posts, reactions, joins), per device
    ads: b(30, per(30, 60)),                // sponsored post requests and clicks, per device
  };
}

export const MAX_SOCKETS_PER_IP = 32;

/** Per-day caps on what counts toward revenue share, so nobody can farm their own allocation. */
export const DAILY_CAPS = { usage: 2000, network: 2000, research: 200 };
