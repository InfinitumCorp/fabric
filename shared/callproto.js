// FABRIC call signaling. Every message below travels inside the Double Ratchet session between
// two devices, like a chat message, so the relay never sees SDP, ICE candidates or media keys.
// Because the SDP carries the DTLS fingerprints, authenticating it this way makes each WebRTC
// link end to end: a relay that swaps fingerprints cannot produce a valid ratchet message.
//
// A small call is a full mesh of devices (a 1:1 call is a mesh of two). A larger one moves its
// media to the relay's SFU, which forwards frames that stay end-to-end encrypted: the roster then
// names the SFU room, and invites and answers carry no SDP (each device links to the relay).
//
//   invite  { id, video, sdp?, sfu?, e2ee, key?, kid? }  a member → every device of the person added
//   answer  { id, sdp?, sfu?, e2ee, key?, kid? }         the one device that picked up → the inviter
//   reject  { id }                                invited device declined
//   busy    { id }                                invited device is already in a call
//   hangup  { id, reason }                        leaving the call (or cancelling an invite)
//   roster  { id, members[], sfu? }               a member's view of who is in the call (and its room)
//   offer   { id, sdp, e2ee, key?, kid? }         connect two members that are not linked yet
//   accept  { id, sdp, e2ee, key?, kid? }         reply to an offer
//   key     { id, key, kid }                      the sender's new media key (rotation)
//   media   { id, screen }                        the sender started or stopped sharing a screen
//
// Media keys are sender keys: each device encrypts its frames with its own key and sends that key
// to every other member. A device makes a new key whenever someone joins or leaves, and every
// ROTATE_MS, and sends it only to the members present at that moment.

import { unb64, isValidHandle } from './crypto.js';
import { parseAddr, DEVICE_ID_RE } from './devices.js';

export const CALL_RING_MS = 45_000;      // ring this long before "no answer"
export const INVITE_MAX_AGE_MS = 60_000; // older invites (from an offline queue) are missed calls
export const MEDIA_KEY_BYTES = 32;
export const MAX_CALL_DEVICES = 8;       // full mesh: every device sends to every other one
export const MAX_SFU_DEVICES = 50;       // through the relay's SFU
export const SFU_FROM = 5;               // calls with this many devices use the SFU (when the relay has one)
export const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const ROTATE_MS = 10 * 60_000;    // periodic sender-key rotation
export const OPS = ['invite', 'answer', 'reject', 'busy', 'hangup', 'roster', 'offer', 'accept', 'key', 'media'];
export const HANGUP_REASONS = ['ended', 'cancelled', 'answered-elsewhere', 'declined', 'no-answer', 'failed'];

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_SDP = 64_000;

function mediaKey(p) {
  let key;
  try { key = unb64(String(p.key)); } catch { throw new Error('bad media key'); }
  if (key.length !== MEDIA_KEY_BYTES) throw new Error('bad media key');
  const kid = p.kid === undefined ? 0 : p.kid;
  if (!Number.isInteger(kid) || kid < 0 || kid > 255) throw new Error('bad key id');
  return { key: p.key, kid };
}

export function isDeviceAddr(a) {
  if (typeof a !== 'string') return false;
  const { handle, deviceId } = parseAddr(a);
  return isValidHandle(handle) && DEVICE_ID_RE.test(deviceId);
}

/** Validate and normalize a decrypted call payload. Throws on anything malformed. */
export function parseCallSignal(p) {
  if (!p || p.kind !== 'call') throw new Error('not a call signal');
  if (!ID_RE.test(String(p.id))) throw new Error('bad call id');
  if (!OPS.includes(p.op)) throw new Error('bad call op');
  const out = { op: p.op, id: p.id };
  const viaSfu = (p.op === 'invite' || p.op === 'answer') && p.sfu !== undefined;
  if (viaSfu) {
    if (!ROOM_RE.test(String(p.sfu))) throw new Error('bad room');
    out.sfu = p.sfu;
  }
  if (['invite', 'answer', 'offer', 'accept'].includes(p.op)) {
    if (viaSfu && p.sdp === undefined) {
      if (p.e2ee !== true) throw new Error('large calls need frame encryption');
    } else {
      if (typeof p.sdp !== 'string' || p.sdp.length > MAX_SDP || !p.sdp.startsWith('v=0')) throw new Error('bad sdp');
      out.sdp = p.sdp;
    }
    out.e2ee = p.e2ee === true;
    if (out.e2ee) Object.assign(out, mediaKey(p));
    if (p.op === 'invite') out.video = p.video === true;
  }
  if (p.op === 'key') Object.assign(out, mediaKey(p));
  if (p.op === 'roster') {
    if (p.sfu !== undefined) {
      if (!ROOM_RE.test(String(p.sfu))) throw new Error('bad room');
      out.sfu = p.sfu;
    }
    if (!Array.isArray(p.members) || p.members.length > (out.sfu ? MAX_SFU_DEVICES : MAX_CALL_DEVICES)) throw new Error('bad roster');
    if (!p.members.every(isDeviceAddr)) throw new Error('bad roster');
    out.members = [...new Set(p.members)];
  }
  if (p.op === 'media') out.screen = p.screen === true;
  if (p.op === 'hangup') out.reason = HANGUP_REASONS.includes(p.reason) ? p.reason : 'ended';
  return out;
}

export const inviteExpired = (sentAt, now = Date.now()) => !(now - Number(sentAt) < INVITE_MAX_AGE_MS);

/**
 * Both sides called each other at once. The invite with the smaller id wins; the other caller
 * cancels its own invite and rings for the winning one instead.
 */
export const glareYield = (myCallId, theirCallId) => theirCallId < myCallId;

/** In the mesh, of two members not yet linked, the one with the smaller address sends the offer. */
export const offersTo = (myAddr, theirAddr) => myAddr < theirAddr;

/**
 * Merge a roster from a trusted member into my view. Members who left stay out (a stale roster
 * can't bring them back), and the call never grows past `cap` devices.
 * Returns the addresses that are new to me.
 */
export function mergeRoster(members, incoming, left, cap = MAX_CALL_DEVICES) {
  const added = [];
  for (const a of incoming) {
    if (members.has(a) || left.has(a)) continue;
    if (members.size >= cap) break;
    members.add(a);
    added.push(a);
  }
  return added;
}

/** Two members started SFU rooms at once: everyone settles on the smaller room id. */
export const preferRoom = (mine, theirs) => (!mine || theirs < mine ? theirs : mine);

/** Next key id: one byte, wraps. Receivers keep a sender's previous key during the switch. */
export const nextKid = (kid) => (kid + 1) & 0xff;

export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
