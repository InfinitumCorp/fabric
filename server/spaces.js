// Large groups and channels on the relay (see shared/spaces.js for the model and its privacy
// trade-off). The relay holds members, roles, invites, posts, reaction and view counts. Bodies of
// private spaces are ciphertext it can't open; bodies of public channels are plaintext.

import { createHash, randomBytes } from 'node:crypto';
import { isValidHandle } from '../shared/crypto.js';
import {
  SPACE_ID_RE, INVITE_RE, KINDS, TOPICS, REACTIONS, MAX_ADMINS, can, postBody, cleanName, cleanAbout, channelHandle,
} from '../shared/spaces.js';

const MAX_CHANNEL_SUBSCRIBERS = 5_000_000;
const PAGE = 50;
const rid = (n = 16) => randomBytes(n).toString('base64url');
const err = (message, status = 400) => Object.assign(new Error(message), { status });

export function createSpaces({ store, entitlements, log = () => {}, now = () => Date.now(), push = () => {}, secret }) {
  const db = store.db;
  db.exec(`
CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL, visibility TEXT NOT NULL, handle TEXT UNIQUE,
  name TEXT NOT NULL, about TEXT NOT NULL DEFAULT '', topic TEXT, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0, ads INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS spaces_owner ON spaces (owner);
CREATE TABLE IF NOT EXISTS space_members (sid TEXT NOT NULL, handle TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (sid, handle));
CREATE INDEX IF NOT EXISTS space_members_handle ON space_members (handle);
CREATE TABLE IF NOT EXISTS space_bans (sid TEXT NOT NULL, handle TEXT NOT NULL, PRIMARY KEY (sid, handle));
CREATE TABLE IF NOT EXISTS space_invites (code TEXT PRIMARY KEY, sid TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS space_invites_sid ON space_invites (sid);
CREATE TABLE IF NOT EXISTS space_posts (seq INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, id TEXT NOT NULL UNIQUE, author TEXT NOT NULL,
  body TEXT NOT NULL, at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS space_posts_sid ON space_posts (sid, seq);
CREATE TABLE IF NOT EXISTS space_reactions (seq INTEGER NOT NULL, handle TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY (seq, handle));
CREATE TABLE IF NOT EXISTS space_views (seq INTEGER NOT NULL, viewer TEXT NOT NULL, PRIMARY KEY (seq, viewer));
`);
  const q = (sql) => db.prepare(sql);
  const space = (sid) => (SPACE_ID_RE.test(String(sid)) ? q('SELECT * FROM spaces WHERE id = ?').get(sid) : null);
  const roleOf = (sid, h) => q('SELECT role FROM space_members WHERE sid = ? AND handle = ?').get(sid, h)?.role || null;
  const count = (sid) => q('SELECT COUNT(*) AS n FROM space_members WHERE sid = ?').get(sid).n;
  // a view is counted once per reader, under a hash that differs per space (not linkable across spaces)
  const viewerId = (sid, h) => createHash('sha256').update(`${secret}|${sid}|${h}`).digest('base64url').slice(0, 22);

  function need(sid, me, action) {
    const s = space(sid);
    if (!s) throw err('unknown space', 404);
    const role = roleOf(s.id, me);
    if (!role) throw err('not a member', 403);
    if (!can(role, action, s.kind)) throw err('not allowed', 403);
    return { s, role };
  }

  function summary(s, me) {
    const last = q('SELECT seq, at FROM space_posts WHERE sid = ? AND deleted = 0 ORDER BY seq DESC LIMIT 1').get(s.id);
    return {
      id: s.id, kind: s.kind, visibility: s.visibility, handle: s.handle, name: s.name, about: s.about, topic: s.topic,
      owner: s.kind === 'group' || roleOf(s.id, me) !== 'member' ? s.owner : undefined,
      epoch: s.epoch, ads: Boolean(s.ads), members: count(s.id), role: me ? roleOf(s.id, me) : null,
      lastSeq: last?.seq || 0, lastAt: last?.at || s.created_at, createdAt: s.created_at,
      e2ee: s.visibility === 'private',
    };
  }

  function postOut(p, me) {
    const r = q('SELECT emoji, COUNT(*) AS n FROM space_reactions WHERE seq = ? GROUP BY emoji').all(p.seq);
    const mine = me ? q('SELECT emoji FROM space_reactions WHERE seq = ? AND handle = ?').get(p.seq, me)?.emoji || null : null;
    const s = space(p.sid);
    return {
      seq: p.seq, id: p.id, sid: p.sid, at: p.at, views: p.views,
      // channels speak as the channel; who of the admins posted is shown to admins only
      author: s.kind === 'group' || (me && roleOf(s.id, me) && roleOf(s.id, me) !== 'member') ? p.author : null,
      body: JSON.parse(p.body), reactions: Object.fromEntries(r.map((x) => [x.emoji, x.n])), mine,
    };
  }

  function membersOf(sid) { return q('SELECT handle FROM space_members WHERE sid = ?').all(sid).map((r) => r.handle); }

  // ---------- operations (me = the caller's handle) ----------
  const ops = {
    create(me, { kind, visibility, name, about, topic, handle }) {
      if (!KINDS.includes(kind)) throw err('kind: group or channel');
      if (!['public', 'private'].includes(visibility)) throw err('visibility: public or private');
      if (kind === 'group' && visibility === 'public') throw err('groups are private (end-to-end encrypted); make a public channel instead');
      const n = cleanName(name);
      if (!n) throw err('name required');
      const ent = entitlements(me);
      if (kind === 'channel') {
        const owned = q("SELECT COUNT(*) AS n FROM spaces WHERE owner = ? AND kind = 'channel'").get(me).n;
        if (owned >= ent.ownedChannels) throw err(`your plan allows ${ent.ownedChannels} channels`, 402);
      }
      let h = null;
      if (visibility === 'public') {
        h = channelHandle(handle);
        if (!h) throw err('a public channel needs an address like +name.veil (2-24 letters, digits or _)');
        if (store.getList(h) || q('SELECT 1 FROM spaces WHERE handle = ?').get(h)) throw err('that address is taken', 409);
      }
      if (topic != null && !TOPICS.includes(topic)) throw err('unknown topic');
      const id = rid(16);
      store.tx(() => {
        q('INSERT INTO spaces (id, kind, visibility, handle, name, about, topic, owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, kind, visibility, h, n, cleanAbout(about), topic ?? null, me, now());
        q("INSERT INTO space_members (sid, handle, role, joined_at) VALUES (?, ?, 'owner', ?)").run(id, me, now());
      });
      log(`[spaces] ${me} made a ${visibility} ${kind}`);
      return { space: summary(space(id), me) };
    },

    list(me) {
      const rows = q('SELECT s.* FROM spaces s JOIN space_members m ON m.sid = s.id WHERE m.handle = ?').all(me);
      return { spaces: rows.map((s) => summary(s, me)) };
    },

    get(me, { sid }) { return { space: summary(need(sid, me, 'read').s, me) }; },

    /** Look up a public channel by its address, or a private space by an invite code. */
    resolve(me, { handle, invite }) {
      if (invite != null) {
        const inv = INVITE_RE.test(String(invite)) && q('SELECT * FROM space_invites WHERE code = ?').get(invite);
        if (!inv || inv.revoked || (inv.expires_at && inv.expires_at < now()) || (inv.max_uses && inv.uses >= inv.max_uses)) throw err('invite link expired or revoked', 404);
        const s = space(inv.sid);
        return { space: { ...summary(s, me), owner: undefined } };
      }
      const h = channelHandle(handle);
      const s = h && q("SELECT * FROM spaces WHERE handle = ? AND visibility = 'public'").get(h);
      if (!s) throw err('no public channel at that address', 404);
      return { space: summary(s, me) };
    },

    join(me, { handle, invite }) {
      let s; let inv = null;
      if (invite != null) {
        inv = INVITE_RE.test(String(invite)) && q('SELECT * FROM space_invites WHERE code = ?').get(invite);
        if (!inv || inv.revoked || (inv.expires_at && inv.expires_at < now()) || (inv.max_uses && inv.uses >= inv.max_uses)) throw err('invite link expired or revoked', 404);
        s = space(inv.sid);
      } else {
        const h = channelHandle(handle);
        s = h && q("SELECT * FROM spaces WHERE handle = ? AND visibility = 'public'").get(h);
        if (!s) throw err('no public channel at that address', 404);
      }
      if (q('SELECT 1 FROM space_bans WHERE sid = ? AND handle = ?').get(s.id, me)) throw err('you were removed from this space', 403);
      if (!roleOf(s.id, me)) {
        const cap = s.kind === 'group' ? entitlements(s.owner).groupMembers : MAX_CHANNEL_SUBSCRIBERS;
        if (count(s.id) >= cap) throw err(`this group is full (${cap.toLocaleString('en-US')} members on its owner's plan)`, 409);
        store.tx(() => {
          q("INSERT INTO space_members (sid, handle, role, joined_at) VALUES (?, ?, 'member', ?)").run(s.id, me, now());
          if (inv) q('UPDATE space_invites SET uses = uses + 1 WHERE code = ?').run(inv.code);
        });
        if (s.kind === 'group') push(membersOf(s.id), { type: 'space_member', sid: s.id, handle: me, op: 'join' });
      }
      return { space: summary(s, me) };
    },

    leave(me, { sid }) {
      const { s, role } = need(sid, me, 'leave');
      if (role === 'owner') throw err('the owner can delete the space but not leave it');
      q('DELETE FROM space_members WHERE sid = ? AND handle = ?').run(s.id, me);
      if (s.kind === 'group') push(membersOf(s.id), { type: 'space_member', sid: s.id, handle: me, op: 'leave' });
      return { left: true, rotate: s.visibility === 'private' };
    },

    edit(me, { sid, name, about, topic, ads }) {
      const { s } = need(sid, me, 'edit');
      if (topic !== undefined && topic !== null && !TOPICS.includes(topic)) throw err('unknown topic');
      q('UPDATE spaces SET name = ?, about = ?, topic = ?, ads = ? WHERE id = ?').run(
        name !== undefined ? cleanName(name) || s.name : s.name, about !== undefined ? cleanAbout(about) : s.about,
        topic !== undefined ? topic : s.topic, ads !== undefined ? (ads ? 1 : 0) : s.ads, s.id);
      return { space: summary(space(s.id), me) };
    },

    remove_space(me, { sid }) {
      const { s } = need(sid, me, 'delete_space');
      const members = membersOf(s.id);
      store.tx(() => {
        for (const t of ['space_members', 'space_bans', 'space_invites']) q(`DELETE FROM ${t} WHERE sid = ?`).run(s.id);
        q('DELETE FROM space_reactions WHERE seq IN (SELECT seq FROM space_posts WHERE sid = ?)').run(s.id);
        q('DELETE FROM space_views WHERE seq IN (SELECT seq FROM space_posts WHERE sid = ?)').run(s.id);
        q('DELETE FROM space_posts WHERE sid = ?').run(s.id);
        q('DELETE FROM spaces WHERE id = ?').run(s.id);
      });
      push(members, { type: 'space_gone', sid: s.id });
      return { deleted: true };
    },

    invite_create(me, { sid, expiresIn, maxUses }) {
      const { s } = need(sid, me, 'invite');
      const exp = expiresIn == null ? null : Number(expiresIn);
      const max = maxUses == null ? null : Number(maxUses);
      if (exp !== null && !(exp >= 60_000 && exp <= 365 * 86400_000)) throw err('expiresIn: 1 minute to 1 year, in ms');
      if (max !== null && !(Number.isInteger(max) && max >= 1 && max <= 1e6)) throw err('maxUses: 1 to 1,000,000');
      const code = rid(16);
      q('INSERT INTO space_invites (code, sid, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)').run(code, s.id, me, now(), exp ? now() + exp : null, max);
      return { invite: { code, expiresAt: exp ? now() + exp : null, maxUses: max, uses: 0 } };
    },

    invites(me, { sid }) {
      const { s } = need(sid, me, 'invite');
      return { invites: q('SELECT code, created_at AS createdAt, expires_at AS expiresAt, max_uses AS maxUses, uses, revoked FROM space_invites WHERE sid = ? ORDER BY created_at DESC LIMIT 100').all(s.id).map((i) => ({ ...i, revoked: Boolean(i.revoked) })) };
    },

    invite_revoke(me, { sid, code }) {
      const { s } = need(sid, me, 'invite');
      q('UPDATE space_invites SET revoked = 1 WHERE sid = ? AND code = ?').run(s.id, String(code));
      return { revoked: true };
    },

    members(me, { sid, offset = 0 }) {
      const { s, role } = need(sid, me, 'read');
      // channel subscriber lists are for admins only; group members see each other
      if (s.kind === 'channel' && role === 'member') throw err('only admins see the subscriber list', 403);
      const rows = q("SELECT handle, role, joined_at AS joinedAt FROM space_members WHERE sid = ? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, joined_at LIMIT 200 OFFSET ?").all(s.id, Math.max(0, Number(offset) | 0));
      return { members: rows, total: count(s.id) };
    },

    role(me, { sid, handle, role }) {
      const { s } = need(sid, me, 'promote');
      if (!['admin', 'member'].includes(role)) throw err('role: admin or member');
      const cur = roleOf(s.id, handle);
      if (!cur) throw err('not a member');
      if (cur === 'owner') throw err('the owner stays the owner');
      if (role === 'admin' && q("SELECT COUNT(*) AS n FROM space_members WHERE sid = ? AND role = 'admin'").get(s.id).n >= MAX_ADMINS) throw err(`up to ${MAX_ADMINS} admins`);
      q('UPDATE space_members SET role = ? WHERE sid = ? AND handle = ?').run(role, s.id, handle);
      push([handle], { type: 'space_role', sid: s.id, role });
      return { handle, role };
    },

    remove(me, { sid, handle }) {
      const { s, role } = need(sid, me, 'remove');
      const theirs = roleOf(s.id, handle);
      if (!theirs) throw err('not a member');
      if (theirs === 'owner' || (theirs === 'admin' && role !== 'owner')) throw err('not allowed', 403);
      store.tx(() => {
        q('DELETE FROM space_members WHERE sid = ? AND handle = ?').run(s.id, handle);
        q('INSERT OR IGNORE INTO space_bans (sid, handle) VALUES (?, ?)').run(s.id, handle);
      });
      push([handle], { type: 'space_gone', sid: s.id });
      // the relay stops serving them at once; for private spaces the admin's device rotates the key
      return { removed: handle, rotate: s.visibility === 'private' };
    },

    unban(me, { sid, handle }) {
      const { s } = need(sid, me, 'remove');
      q('DELETE FROM space_bans WHERE sid = ? AND handle = ?').run(s.id, String(handle));
      return { unbanned: handle };
    },

    /** A new key epoch (private spaces). The admin's device sends the new key to members itself. */
    rotate(me, { sid }) {
      const { s } = need(sid, me, 'rotate');
      if (s.visibility !== 'private') throw err('public channels have no key');
      q('UPDATE spaces SET epoch = epoch + 1 WHERE id = ?').run(s.id);
      const epoch = space(s.id).epoch;
      push(membersOf(s.id), { type: 'space_epoch', sid: s.id, epoch });
      return { epoch, members: membersOf(s.id) };
    },

    post(me, { sid, id, body }) {
      const { s } = need(sid, me, 'post');
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw err('bad post id');
      const b = postBody(body, s.visibility, entitlements(me).uploadBytes);
      if (!b) throw err(s.visibility === 'public' ? 'empty post' : `post too large for your plan or malformed (up to ${Math.round(entitlements(me).uploadBytes / 1048576)} MB)`, 413);
      if (s.visibility === 'private' && b.e !== s.epoch) throw err('stale key epoch', 409);
      if (q('SELECT 1 FROM space_posts WHERE id = ?').get(id)) throw err('duplicate post id', 409);
      const r = q('INSERT INTO space_posts (sid, id, author, body, at) VALUES (?, ?, ?, ?, ?)').run(s.id, id, me, JSON.stringify(b), now());
      const p = q('SELECT * FROM space_posts WHERE seq = ?').get(Number(r.lastInsertRowid));
      push(membersOf(s.id), (h) => ({ type: 'space_post', post: postOut(p, h) }));
      return { post: postOut(p, me) };
    },

    posts(me, { sid, before, limit = PAGE }) {
      const { s } = need(sid, me, 'read');
      const n = Math.min(PAGE, Math.max(1, Number(limit) | 0));
      const rows = before
        ? q('SELECT * FROM space_posts WHERE sid = ? AND deleted = 0 AND seq < ? ORDER BY seq DESC LIMIT ?').all(s.id, Number(before), n)
        : q('SELECT * FROM space_posts WHERE sid = ? AND deleted = 0 ORDER BY seq DESC LIMIT ?').all(s.id, n);
      return { sid: s.id, posts: rows.reverse().map((p) => postOut(p, me)) };
    },

    delete_post(me, { sid, seq }) {
      const { s } = need(sid, me, 'read');
      const p = q('SELECT * FROM space_posts WHERE seq = ? AND sid = ?').get(Number(seq), s.id);
      if (!p) throw err('unknown post', 404);
      if (p.author !== me && !can(roleOf(s.id, me), 'delete_post', s.kind)) throw err('not allowed', 403);
      q("UPDATE space_posts SET deleted = 1, body = '{}' WHERE seq = ?").run(p.seq);
      q('DELETE FROM space_reactions WHERE seq = ?').run(p.seq);
      push(membersOf(s.id), { type: 'space_unpost', sid: s.id, seq: p.seq });
      return { deleted: p.seq };
    },

    react(me, { sid, seq, emoji }) {
      const { s } = need(sid, me, 'react');
      const p = q('SELECT * FROM space_posts WHERE seq = ? AND sid = ? AND deleted = 0').get(Number(seq), s.id);
      if (!p) throw err('unknown post', 404);
      if (emoji === null) q('DELETE FROM space_reactions WHERE seq = ? AND handle = ?').run(p.seq, me);
      else if (!REACTIONS.includes(emoji)) throw err('unsupported reaction');
      else q('INSERT INTO space_reactions (seq, handle, emoji) VALUES (?, ?, ?) ON CONFLICT (seq, handle) DO UPDATE SET emoji = excluded.emoji').run(p.seq, me, emoji);
      const out = postOut(p, me);
      push(membersOf(s.id), (h) => ({ type: 'space_reacted', sid: s.id, seq: p.seq, reactions: out.reactions, mine: h === me ? out.mine : undefined }));
      return { seq: p.seq, reactions: out.reactions, mine: out.mine };
    },

    view(me, { sid, seqs }) {
      const { s } = need(sid, me, 'read');
      if (!Array.isArray(seqs)) throw err('seqs: a list');
      const v = viewerId(s.id, me);
      const out = {};
      store.tx(() => {
        for (const seq of seqs.slice(0, 100).map(Number).filter(Number.isInteger)) {
          const p = q('SELECT seq FROM space_posts WHERE seq = ? AND sid = ?').get(seq, s.id);
          if (!p) continue;
          if (q('INSERT OR IGNORE INTO space_views (seq, viewer) VALUES (?, ?)').run(seq, v).changes) q('UPDATE space_posts SET views = views + 1 WHERE seq = ?').run(seq);
          out[seq] = q('SELECT views FROM space_posts WHERE seq = ?').get(seq).views;
        }
      });
      return { sid: s.id, views: out };
    },
  };

  /** WebSocket entry: space_<op>. Returns a reply object (type space_<op>) or throws. */
  function ws(me, msg) {
    const op = String(msg.type).slice('space_'.length);
    const fn = Object.hasOwn(ops, op) ? ops[op] : null;
    if (!fn) throw err('unknown type');
    return { type: msg.type, ...fn(me, msg) };
  }

  /** Read-only preview of a public channel for people without an account (or not subscribed). */
  function publicPreview(handle) {
    const h = channelHandle(handle);
    const s = h && q("SELECT * FROM spaces WHERE handle = ? AND visibility = 'public'").get(h);
    if (!s) return null;
    const posts = q('SELECT * FROM space_posts WHERE sid = ? AND deleted = 0 ORDER BY seq DESC LIMIT 20').all(s.id).reverse().map((p) => ({ ...postOut(p, null), author: null }));
    const { owner, role, ...sum } = summary(s, null);
    return { space: sum, posts };
  }

  return { ws, ops, publicPreview, space, roleOf, isMember: (sid, h) => Boolean(roleOf(sid, h)), handleTaken: (h) => Boolean(q('SELECT 1 FROM spaces WHERE handle = ?').get(h)) };
}
