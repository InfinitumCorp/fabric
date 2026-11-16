// Runs the media frame encryption off the main thread. One worker per call, shared by every
// peer connection in it. Works with RTCRtpScriptTransform (standard) and with Chrome's
// createEncodedStreams (legacy).
//
// Sender keys: this device encrypts with its current key (kid). For each other member we keep
// their current and previous key, so frames still in flight during a rotation decrypt.
import { importMediaKey, encryptFrame, decryptFrame, clearBytesFor } from '/shared/frame-crypto.js';

const plain = new Set(); // peers without frame transforms: pass their frames through (DTLS-SRTP only)
let send = null;    // { kid, key }
const recv = new Map(); // peer address → Map(kid → CryptoKey), newest last, at most 2
const stats = new Map(); // peer address → { dec, fail }
// Through the SFU, one receiver (a slot) carries whoever the relay assigns to it: slot tag →
// the sender's key tag. A relay that mislabels a slot gains nothing: the frames don't decrypt.
const route = new Map();
const total = { enc: 0 };

setInterval(() => self.postMessage({ type: 'stats', enc: total.enc, peers: Object.fromEntries(stats) }), 1000);

const statFor = (peer) => {
  if (!stats.has(peer)) stats.set(peer, { dec: 0, fail: 0 });
  return stats.get(peer);
};

function pipe(readable, writable, { dir, kind, peer }) {
  readable.pipeThrough(new TransformStream({
    async transform(frame, ctl) {
      if (plain.has(peer) || frame.data.byteLength === 0) return ctl.enqueue(frame);
      const clear = clearBytesFor(kind, frame.type);
      if (dir === 'send') {
        if (!send) return; // no key yet: drop rather than send in the clear
        frame.data = await encryptFrame(send.key, frame.data, clear, send.kid);
        total.enc++;
        return ctl.enqueue(frame);
      }
      const from = route.get(peer) ?? peer;
      if (plain.has(from)) return ctl.enqueue(frame);
      const keys = recv.get(from);
      const s = statFor(from);
      try {
        frame.data = await decryptFrame((kid) => keys?.get(kid), frame.data, clear);
        s.dec++;
        ctl.enqueue(frame);
      } catch {
        s.fail++; // unknown key or tampered frame: drop it rather than feed garbage to the decoder
      }
    },
  })).pipeTo(writable).catch(() => {});
}

self.onmessage = async ({ data }) => {
  switch (data.type) {
    case 'send-key':
      send = { kid: data.kid, key: await importMediaKey(data.key) };
      break;
    case 'recv-key': {
      const key = await importMediaKey(data.key);
      const m = recv.get(data.peer) || new Map();
      m.delete(data.kid);
      m.set(data.kid, key);
      while (m.size > 2) m.delete(m.keys().next().value);
      recv.set(data.peer, m);
      break;
    }
    case 'drop-peer':
      recv.delete(data.peer);
      plain.delete(data.peer);
      stats.delete(data.peer);
      break;
    case 'route':
      if (data.peer) route.set(data.tag, data.peer); else route.delete(data.tag);
      break;
    case 'plain':
      plain.add(data.peer);
      break;
    case 'stream':
      pipe(data.readable, data.writable, data);
      break;
  }
};

self.onrtctransform = ({ transformer: t }) => pipe(t.readable, t.writable, t.options);
