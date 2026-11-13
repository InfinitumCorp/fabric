// The relay's side of several SFU nodes (server/sfu-node.js). Same interface as one SFU
// (ws, gone, stats, close), so the relay doesn't care which it has.
//
// Placement: a member joins the node that already hosts most of its room and has room left
// (FABRIC_SFU_NODE_CAP members per room per node); when none has, the least loaded node takes it
// and is linked to every other node hosting the room, so media flows between them.
//
//   FABRIC_SFU_NODES=wss://sfu1.example.com:8800,wss://sfu2.example.com:8800
//   FABRIC_SFU_NODE_SECRET=<the same on the relay and every node>
//   FABRIC_SFU_NODE_CAP=25

import WebSocket from 'ws';
import { nodeToken } from './sfu-link.js';
import { ROOM_RE, MAX_ROOM } from './sfu.js';

const REQUEST_MS = 20_000;

export function clusterFromEnv(env = process.env) {
  const urls = (env.FABRIC_SFU_NODES || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!urls.length) return null;
  for (const u of urls) if (!/^wss?:\/\/[^\s/]+\/?$/.test(u)) throw new Error(`FABRIC_SFU_NODES: not a ws:// or wss:// origin: ${u}`);
  const secret = env.FABRIC_SFU_NODE_SECRET || '';
  if (secret.length < 16) throw new Error('FABRIC_SFU_NODES needs FABRIC_SFU_NODE_SECRET (16+ characters)');
  const cap = Number(env.FABRIC_SFU_NODE_CAP || 25);
  if (!Number.isInteger(cap) || cap < 1) throw new Error('FABRIC_SFU_NODE_CAP must be a positive whole number');
  return { urls: urls.map((u) => u.replace(/\/$/, '')), secret, cap };
}

export function createSfuCluster({ urls, secret, cap = 25, maxRoom = MAX_ROOM, send, log = () => {} }) {
  const nodes = urls.map((url) => ({ url, ws: null, up: false, seq: 0, waiting: new Map(), retry: 1000, timer: null }));
  const memberNode = new Map(); // addr → node
  const memberRoom = new Map(); // addr → room
  const rooms = new Map();      // room → Map(node → members there)
  let closed = false;

  function connect(n) {
    if (closed) return;
    const u = new URL(`${n.url}/ctl`);
    u.searchParams.set('token', nodeToken(secret, 'ctl'));
    const ws = n.ws = new WebSocket(u, { perMessageDeflate: false, handshakeTimeout: 5000 });
    ws.on('open', () => { n.up = true; n.retry = 1000; log(`[sfu-cluster] node ${n.url} up`); });
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.id != null) { const w = n.waiting.get(m.id); if (w) { n.waiting.delete(m.id); clearTimeout(w.t); w.resolve(m.r); } return; }
      if (m.t === 'send' && typeof m.addr === 'string' && memberNode.get(m.addr) === n) return send(m.addr, m.msg);
      if (m.t === 'room' && ROOM_RE.test(m.room) && Number.isInteger(m.members)) setCount(m.room, n, m.members);
    });
    ws.on('close', () => {
      if (n.ws !== ws) return;
      const was = n.up;
      n.up = false;
      for (const w of n.waiting.values()) { clearTimeout(w.t); w.resolve('media node unavailable'); }
      n.waiting.clear();
      if (was) log(`[sfu-cluster] node ${n.url} lost`);
      // its members' media is gone; tell them so their clients rejoin (onto another node)
      for (const [addr, node] of [...memberNode]) {
        if (node !== n) continue;
        const room = memberRoom.get(addr);
        forget(addr);
        send(addr, { type: 'sfu_closed', room, reason: 'media node lost' });
      }
      for (const room of [...rooms.keys()]) setCount(room, n, 0);
      if (!closed) { n.timer = setTimeout(() => connect(n), n.retry); n.retry = Math.min(n.retry * 2, 10_000); }
    });
    ws.on('error', () => {});
  }

  function request(n, o) {
    if (!n.up || n.ws.readyState !== 1) return Promise.resolve('media node unavailable');
    const id = ++n.seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => { n.waiting.delete(id); resolve('media node timed out'); }, REQUEST_MS);
      n.waiting.set(id, { resolve, t });
      n.ws.send(JSON.stringify({ ...o, id }));
    });
  }
  const tell = (n, o) => { if (n.up && n.ws.readyState === 1) n.ws.send(JSON.stringify(o)); };

  function setCount(room, n, count) {
    let m = rooms.get(room);
    if (!m) { if (!count) return; m = new Map(); rooms.set(room, m); }
    if (count > 0) m.set(n, count); else m.delete(n);
    if (!m.size) rooms.delete(room);
  }
  const count = (room, n) => rooms.get(room)?.get(n) || 0;
  const total = (room) => [...(rooms.get(room)?.values() || [])].reduce((a, b) => a + b, 0);
  const load = (n) => [...rooms.values()].reduce((a, m) => a + (m.get(n) || 0), 0);

  function forget(addr) {
    const n = memberNode.get(addr);
    const room = memberRoom.get(addr);
    memberNode.delete(addr);
    memberRoom.delete(addr);
    if (n && room) setCount(room, n, Math.max(0, count(room, n) - 1));
  }

  /** The node for a newcomer to `room`, and the nodes it has to be linked to. */
  function place(room) {
    const up = nodes.filter((n) => n.up);
    if (!up.length) return null;
    const hosting = up.filter((n) => count(room, n) > 0);
    const fit = hosting.filter((n) => count(room, n) < cap).sort((a, b) => count(room, b) - count(room, a));
    if (fit.length) return { node: fit[0], linkTo: [] };
    const fresh = up.filter((n) => count(room, n) === 0).sort((a, b) => load(a) - load(b));
    if (!fresh.length) return { node: hosting.sort((a, b) => count(room, a) - count(room, b))[0], linkTo: [] }; // every node is full: overfill the emptiest
    return { node: fresh[0], linkTo: hosting };
  }

  async function join(addr, msg) {
    const room = msg.room;
    if (!ROOM_RE.test(String(room))) return 'bad room';
    const prev = memberNode.get(addr);
    if (prev) { tell(prev, { t: 'gone', addr }); forget(addr); } // a rejoin starts clean, maybe elsewhere
    if (total(room) >= maxRoom) return 'room full';
    const where = place(room);
    if (!where) return 'large calls are not available right now';
    const { node, linkTo } = where;
    for (const other of linkTo) {
      const r = await request(node, { t: 'link', room, url: `${other.url}/link`, token: nodeToken(secret, 'link', room) });
      if (r !== 'ok') log(`[sfu-cluster] linking ${node.url} to ${other.url} failed: ${r}`);
    }
    memberNode.set(addr, node);
    memberRoom.set(addr, room);
    setCount(room, node, count(room, node) + 1);
    const r = await request(node, { t: 'ws', addr, msg });
    if (typeof r === 'string' && memberNode.get(addr) === node) forget(addr);
    return r;
  }

  for (const n of nodes) connect(n);

  return {
    async ws(addr, msg) {
      if (msg.type === 'sfu_join') return join(addr, msg);
      const n = memberNode.get(addr);
      if (!n) return msg.type === 'sfu_leave' ? null : 'join first';
      if (msg.type === 'sfu_leave') {
        if (memberRoom.get(addr) !== msg.room) return null;
        tell(n, { t: 'gone', addr });
        forget(addr);
        return null;
      }
      return request(n, { t: 'ws', addr, msg });
    },
    gone(addr) {
      const n = memberNode.get(addr);
      if (!n) return;
      tell(n, { t: 'gone', addr });
      forget(addr);
    },
    /** Which node each member is on (for tests and diagnostics). */
    nodeOf: (addr) => memberNode.get(addr)?.url ?? null,
    stats: () => ({ rooms: rooms.size, members: memberNode.size, nodes: nodes.map((n) => ({ url: n.url, up: n.up, members: load(n) })) }),
    close() {
      closed = true;
      for (const n of nodes) { clearTimeout(n.timer); try { n.ws?.close(); } catch { /* gone */ } }
    },
  };
}
