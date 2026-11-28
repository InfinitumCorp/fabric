// Simulcast in the SFU: each sender uploads its video in up to three qualities ("rid" l, m, h),
// and the SFU forwards one of them to each viewer. Pure functions, tested without browsers.
//
// Frames are end-to-end encrypted, but the VP8 payload descriptor is added by the RTP packetizer
// after encryption, and frame encryption leaves the first bytes of each frame clear (as
// SFrame does for VP8). That is enough to find keyframes and to rewrite picture ids, which is all
// a layer switch needs. The SFU never sees a picture.

export const RIDS = ['l', 'm', 'h'];
/** Quality order; '' is a sender without simulcast, which counts as full quality. */
export const rank = (rid) => (rid === 'l' ? 0 : rid === 'm' ? 1 : 2);
export const isQuality = (q) => q === 'l' || q === 'm' || q === 'h';

/**
 * The VP8 payload descriptor (RFC 7741, section 4.2) at the start of an RTP payload, plus whether
 * this packet starts a keyframe. Null when it is too short to be VP8.
 */
export function parseVp8(buf) {
  if (!buf || buf.length < 1) return null;
  const b0 = buf[0];
  const x = b0 & 0x80;
  const start = Boolean(b0 & 0x10) && (b0 & 0x07) === 0; // S bit, partition 0
  let i = 1;
  let pidAt = -1;
  let pidBits = 0;
  let pid = null;
  let tl0At = -1;
  let tl0 = null;
  if (x) {
    if (buf.length < 2) return null;
    const b1 = buf[1];
    i = 2;
    if (b1 & 0x80) { // I: picture id
      if (buf.length < i + 1) return null;
      pidAt = i;
      if (buf[i] & 0x80) {
        if (buf.length < i + 2) return null;
        pidBits = 15; pid = ((buf[i] & 0x7f) << 8) | buf[i + 1]; i += 2;
      } else { pidBits = 7; pid = buf[i] & 0x7f; i += 1; }
    }
    if (b1 & 0x40) { // L: TL0PICIDX
      if (buf.length < i + 1) return null;
      tl0At = i; tl0 = buf[i]; i += 1;
    }
    if (b1 & 0x30) i += 1; // T or K: TID/Y/KEYIDX byte
  }
  if (buf.length <= i) return { start, keyframe: false, pidAt, pidBits, pid, tl0At, tl0, headerLen: i };
  // the VP8 frame header's first byte: P bit 0 means keyframe (it stays clear under frame E2EE)
  const keyframe = start && (buf[i] & 0x01) === 0;
  return { start, keyframe, pidAt, pidBits, pid, tl0At, tl0, headerLen: i };
}

/**
 * The layer to forward: the best one now arriving that is no better than `want`; if all are
 * better, the lowest one. Null when nothing arrives.
 */
export function pickLayer(available, want = 'h') {
  if (!available.length) return null;
  const sorted = [...available].sort((a, b) => rank(a) - rank(b));
  const fit = sorted.filter((r) => rank(r) <= rank(want));
  return fit.length ? fit[fit.length - 1] : sorted[0];
}

/** Quality for each shown video by layout: a big tile gets h, a crowded grid gets l. */
export function qualityFor(position, shown) {
  if (shown <= 2) return 'h';
  if (position === 0) return 'h'; // the presenter or the current speaker is drawn large
  return shown <= 4 ? 'm' : 'l';
}

/**
 * One viewer's copy of one sender's video: which layer it gets, switching only at a keyframe of
 * the new layer, with picture ids (and TL0PICIDX) kept continuous so the viewer's decoder sees one
 * unbroken stream. The caller rewrites RTP sequence numbers and timestamps when `switched`.
 */
export function createLayerForwarder() {
  let cur = null;
  let next = null;
  let pidOff = 0;
  let tl0Off = 0;
  let lastPid = null;
  let lastTl0 = null;
  return {
    get current() { return cur; },
    get pending() { return next; },
    /**
     * Ask for `rid`. `immediate` switches without waiting for a keyframe: for the first layer,
     * or when the current layer stopped arriving (nothing would be shown anyway).
     */
    target(rid, { immediate = false } = {}) {
      if (rid === cur) { next = null; return false; }
      if (cur === null || immediate) { cur = rid; next = null; this.fresh = true; return true; }
      next = rid;
      return true; // the caller asks the sender for a keyframe on `rid`
    },
    /** A packet of layer `rid`: null to drop it, or the payload to send and whether it switched. */
    packet(rid, payload) {
      let switched = Boolean(this.fresh) && rid === cur;
      if (switched) this.fresh = false;
      const d = parseVp8(payload);
      if (rid === next && d?.keyframe) { cur = rid; next = null; switched = true; }
      if (rid !== cur) return null;
      if (!d || (d.pidAt < 0 && d.tl0At < 0)) return { payload, switched };
      const out = Buffer.from(payload);
      if (d.pidAt >= 0) {
        const mask = d.pidBits === 15 ? 0x7fff : 0x7f;
        if (switched && lastPid !== null) pidOff = (lastPid + 1 - d.pid) & mask;
        const p = (d.pid + pidOff) & mask;
        if (d.pidBits === 15) { out[d.pidAt] = 0x80 | (p >> 8); out[d.pidAt + 1] = p & 0xff; } else out[d.pidAt] = p;
        lastPid = p;
      }
      if (d.tl0At >= 0) {
        if (switched && lastTl0 !== null) tl0Off = (lastTl0 + 1 - d.tl0) & 0xff;
        const t = (d.tl0 + tl0Off) & 0xff;
        out[d.tl0At] = t;
        lastTl0 = t;
      }
      return { payload: out, switched };
    },
  };
}
