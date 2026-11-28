// Shared by SFU nodes and the relay: short-lived signed tokens for node connections, and wiring
// one node's part of a room to another's over a WebSocket.

import { createHmac, timingSafeEqual } from 'node:crypto';
import WebSocket from 'ws';

const TOKEN_TTL_S = 60;
const MAX_BUFFERED = 4 * 1024 * 1024; // a slow link drops video packets rather than queueing them

/** A token for `purpose` ('ctl' or 'link') and room, good for a minute. */
export function nodeToken(secret, purpose, room = '', now = Date.now()) {
  const exp = Math.floor(now / 1000) + TOKEN_TTL_S;
  const mac = createHmac('sha256', secret).update(`${purpose}|${room}|${exp}`).digest('base64url');
  return `${exp}.${mac}`;
}

export function checkNodeToken(secret, token, purpose, room = '', now = Date.now()) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m) return false;
  const exp = Number(m[1]);
  const t = Math.floor(now / 1000);
  if (exp < t || exp > t + TOKEN_TTL_S + 5) return false;
  const want = createHmac('sha256', secret).update(`${purpose}|${room}|${exp}`).digest();
  const got = Buffer.from(m[2], 'base64url');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Run a link over an open WebSocket: messages as JSON text, RTP as binary frames. */
export function wireLink(sfu, room, ws, peer) {
  const transport = {
    send: (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
    sendBinary: (b) => {
      if (ws.readyState !== 1) return;
      // audio is small and matters most; video can wait for the next keyframe
      if (ws.bufferedAmount > MAX_BUFFERED && b[0] === 1) return;
      ws.send(b);
    },
    close: () => { try { ws.close(1000, 'room done'); } catch { /* gone */ } },
  };
  const h = sfu.attachLink(room, transport, { peer });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return h.onBinary(data);
    let m;
    try { m = JSON.parse(data); } catch { return; }
    h.onMessage(m);
  });
  ws.on('close', () => h.onClose());
  ws.on('error', () => {});
  return h;
}

/** Dial another node's /link for one room. Resolves once the link is up. */
export function dialLink(sfu, { url, room, token, peer }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    u.searchParams.set('room', room);
    u.searchParams.set('token', token);
    const ws = new WebSocket(u, { perMessageDeflate: false, handshakeTimeout: 5000 });
    ws.once('open', () => { wireLink(sfu, room, ws, peer); resolve(); });
    ws.once('error', (e) => reject(e));
  });
}
