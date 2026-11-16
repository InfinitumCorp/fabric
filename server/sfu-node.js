// A FabriC++ SFU media node: forwards large-call media for the relay, on its own machine.
// The relay keeps all signaling and decides who goes where; a node only moves (encrypted) RTP.
//
//   /ctl    the relay's control connection (token: HMAC of "ctl" with the shared secret)
//   /link   another node joining its part of a room to ours (token: HMAC of "link|<room>")
//
//   FABRIC_SFU_NODE_SECRET=<shared with the relay> SFU_NODE_PORT=8800 npm run sfu-node
//   FABRIC_SFU_PUBLIC_IP, FABRIC_SFU_PORTS   as for the relay's own SFU (public address, UDP range)
//   FABRIC_TLS_CERT, FABRIC_TLS_KEY          serve wss:// (do this whenever the node is on another machine)
//
// Media from browsers and between nodes stays end-to-end encrypted; the control and link sockets
// carry RTP headers and room membership, so run them over TLS.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createSfu, ROOM_RE } from './sfu.js';
import { checkNodeToken, wireLink, dialLink } from './sfu-link.js';

export async function createSfuNode({ port = 8800, host = '0.0.0.0', secret, pcConfig = {}, tls = null, log = console.log }) {
  if (!secret || secret.length < 16) throw new Error('an SFU node needs FABRIC_SFU_NODE_SECRET (16+ characters)');
  let ctl = null; // the relay
  const members = new Set();
  const toRelay = (o) => { if (ctl?.readyState === 1) ctl.send(JSON.stringify(o)); };
  const sfu = createSfu({
    log, pcConfig,
    send: (addr, msg) => toRelay({ t: 'send', addr, msg }),
    onRoom: (room, n) => toRelay({ t: 'room', room, members: n }),
  });

  const server = tls ? https.createServer(tls) : http.createServer();
  server.on('request', (req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, ...sfu.stats() })); }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://node');
    const token = url.searchParams.get('token');
    const room = url.searchParams.get('room') || '';
    const ok = url.pathname === '/ctl' ? checkNodeToken(secret, token, 'ctl')
      : url.pathname === '/link' ? ROOM_RE.test(room) && checkNodeToken(secret, token, 'link', room)
        : false;
    if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => (url.pathname === '/ctl' ? onCtl(ws) : wireLink(sfu, room, ws, 'link-in')));
  });

  function onCtl(ws) {
    ctl?.close(4000, 'replaced');
    ctl = ws;
    ws.on('message', async (data) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      const reply = (r) => { if (m.id != null && ws.readyState === 1) ws.send(JSON.stringify({ id: m.id, r })); };
      try {
        if (m.t === 'ws' && typeof m.addr === 'string' && m.msg && typeof m.msg === 'object') {
          if (m.msg.type === 'sfu_join') members.add(m.addr);
          return reply(await sfu.ws(m.addr, m.msg));
        }
        if (m.t === 'gone') { members.delete(m.addr); return sfu.gone(m.addr); }
        if (m.t === 'link' && ROOM_RE.test(m.room)) {
          await dialLink(sfu, { url: m.url, room: m.room, token: m.token, peer: m.url });
          return reply('ok');
        }
        if (m.t === 'stats') return reply(sfu.stats());
        reply('unknown');
      } catch (e) {
        reply(`node error: ${e.message || e}`);
      }
    });
    ws.on('close', () => {
      if (ctl !== ws) return;
      ctl = null;
      // without the relay nobody can signal these members; they rejoin through it elsewhere
      for (const a of members) sfu.gone(a);
      members.clear();
    });
    ws.on('error', () => {});
  }

  await new Promise((r) => server.listen(port, host, r));
  const actual = server.address().port;
  log(`[sfu-node] listening on ${tls ? 'wss' : 'ws'}://${host}:${actual}`);
  return {
    port: actual,
    sfu,
    close: () => new Promise((r) => {
      sfu.close();
      for (const c of wss.clients) c.terminate();
      server.close(() => r());
      server.closeAllConnections?.();
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { FABRIC_TLS_CERT: cert, FABRIC_TLS_KEY: key } = process.env;
  const pcConfig = {};
  const ip = (process.env.FABRIC_SFU_PUBLIC_IP || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ip.length) pcConfig.iceAdditionalHostAddresses = ip;
  const range = /^(\d+)-(\d+)$/.exec(process.env.FABRIC_SFU_PORTS || '');
  if (range) pcConfig.icePortRange = [Number(range[1]), Number(range[2])];
  await createSfuNode({
    port: Number(process.env.SFU_NODE_PORT || 8800),
    secret: process.env.FABRIC_SFU_NODE_SECRET,
    tls: cert && key ? { cert: fs.readFileSync(cert), key: fs.readFileSync(key) } : null,
    pcConfig,
  });
}
