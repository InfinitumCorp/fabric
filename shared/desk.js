// Desktop-class chat features that need no protocol change: chat folders, Saved messages, drafts,
// scheduled and silent sends, timed mutes, shared media, jump to date, message formatting,
// chat export and keyboard shortcuts. Pure helpers here (tested in test/desk.test.js); the
// page side is public/desk.js.

/** The key of the notes-to-self chat. Real handles start with @ and end in .veil, so it can't clash. */
export const SAVED = '~saved';

// ---------- chat folders ----------
export const BUILTIN_FOLDERS = [
  { id: 'all', name: 'All' },
  { id: 'unread', name: 'Unread' },
  { id: 'favourites', name: 'Favourites' },
  { id: 'personal', name: 'Personal' },
  { id: 'groups', name: 'Groups' },
];
export const MAX_FOLDERS = 10;
export const FOLDER_ID_RE = /^f[a-z0-9]{6,16}$/;

/**
 * Does chat `key` belong in `folder`? `info` = { group, unread, muted }.
 * Custom folders: { id, name, types: ['personal'|'groups'|'unread'], chats: [keys], exclude: [keys], hideMuted }.
 */
export function inFolder(folder, key, info = {}) {
  if (!folder || folder.id === 'all') return true;
  if (folder.id === 'unread') return Boolean(info.unread);
  if (folder.id === 'favourites') return Boolean(info.fav);
  if (folder.id === 'personal') return !info.group && key !== SAVED;
  if (folder.id === 'groups') return Boolean(info.group);
  if (folder.exclude?.includes(key)) return false;
  if (folder.hideMuted && info.muted) return false;
  if (folder.chats?.includes(key)) return true;
  const t = folder.types || [];
  return (t.includes('personal') && !info.group && key !== SAVED)
    || (t.includes('groups') && Boolean(info.group))
    || (t.includes('unread') && Boolean(info.unread));
}

/** A custom folder, checked and trimmed; null when malformed. */
export function cleanFolder(f) {
  if (!f || typeof f !== 'object' || !FOLDER_ID_RE.test(f.id)) return null;
  const name = String(f.name ?? '').trim().slice(0, 24);
  if (!name) return null;
  const keys = (a) => (Array.isArray(a) ? [...new Set(a.filter((k) => typeof k === 'string' && k.length <= 80))].slice(0, 200) : []);
  return {
    id: f.id, name,
    types: keys(f.types).filter((t) => ['personal', 'groups', 'unread'].includes(t)),
    chats: keys(f.chats), exclude: keys(f.exclude), hideMuted: Boolean(f.hideMuted),
  };
}

// ---------- timed mute ----------
export const MUTE_CHOICES = [
  { label: 'For 1 hour', ms: 3600e3 },
  { label: 'For 8 hours', ms: 8 * 3600e3 },
  { label: 'For 1 day', ms: 864e5 },
  { label: 'For 1 week', ms: 7 * 864e5 },
  { label: 'Until I turn it back on', ms: 0 },
];
/** Clears mutes whose time is up. Returns true if anything changed. */
export function expireMutes(prefs, now = Date.now()) {
  let changed = false;
  for (const p of Object.values(prefs || {})) {
    if (p?.muted && p.mutedUntil && p.mutedUntil <= now) { delete p.muted; delete p.mutedUntil; changed = true; }
  }
  return changed;
}
export function muteLabel(p, now = Date.now()) {
  if (!p?.muted) return '';
  if (!p.mutedUntil) return 'Muted';
  const left = p.mutedUntil - now;
  if (left <= 0) return '';
  if (left < 3600e3) return `Muted for ${Math.ceil(left / 60e3)} min`;
  if (left < 864e5) return `Muted for ${Math.ceil(left / 3600e3)} h`;
  return `Muted for ${Math.ceil(left / 864e5)} d`;
}

// ---------- scheduled messages ----------
export const MAX_SCHEDULED = 100;
/** Split the schedule into what is due now and what waits, both oldest first. */
export function dueScheduled(list, now = Date.now()) {
  const sorted = [...(list || [])].sort((a, b) => a.at - b.at);
  return { due: sorted.filter((s) => s.at <= now), later: sorted.filter((s) => s.at > now) };
}
export function validScheduleTime(at, now = Date.now()) {
  return Number.isFinite(at) && at > now + 30e3 && at < now + 366 * 864e5;
}

// ---------- shared media, links, jump to date ----------
export const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/gi;
export function linksIn(text) {
  return [...String(text || '').matchAll(URL_RE)].map((m) => m[0]);
}
/** Everything shared in a thread, newest first: photos, files, voice notes and links. */
export function sharedOf(thread) {
  const out = { media: [], files: [], voice: [], links: [] };
  for (const m of [...(thread || [])].reverse()) {
    if (m.deleted || m.from === '@system') continue;
    if (m.once) continue; // a view-once photo opens only from its message
    if (m.media?.type === 'image') out.media.push(m);
    else if (m.media?.type === 'audio') out.voice.push(m);
    else if (m.media) out.files.push(m);
    for (const url of linksIn(m.text)) out.links.push({ url, m });
  }
  return out;
}
/** The first message on or after the start of the given local day (ms), or the last one before it. */
export function messageOnDay(thread, dayStart) {
  const list = (thread || []).filter((m) => m.from !== '@system');
  return list.find((m) => m.ts >= dayStart) || list.at(-1) || null;
}

// ---------- message formatting ----------
// A small, original markup: **bold**, __italic__, ~~strike~~, `code`, ```block```, ||hidden||.
// Returns tokens for the page to build DOM from (never HTML), so nothing in a message can inject markup.
const FMT = [
  ['pre', /```([\s\S]+?)```/y],
  ['code', /`([^`\n]+)`/y],
  ['b', /\*\*([^*\n](?:[^\n]*?[^*\n])?)\*\*/y],
  ['i', /__([^_\n](?:[^\n]*?[^_\n])?)__/y],
  ['s', /~~([^~\n](?:[^\n]*?[^~\n])?)~~/y],
  ['hide', /\|\|([^|\n](?:[^\n]*?[^|\n])?)\|\|/y],
];
/** [{ t: 'text'|'link'|'b'|'i'|'s'|'code'|'pre'|'hide', v }] */
export function formatTokens(text) {
  const s = String(text ?? '');
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(...linkTokens(buf)); buf = ''; } };
  for (let i = 0; i < s.length;) {
    let hit = null;
    if ('`*_~|'.includes(s[i])) {
      for (const [t, re] of FMT) {
        re.lastIndex = i;
        const m = re.exec(s);
        if (m) { hit = { t, v: m[1], len: m[0].length }; break; }
      }
    }
    if (hit) { flush(); out.push({ t: hit.t, v: hit.v }); i += hit.len; } else { buf += s[i]; i++; }
  }
  flush();
  return out;
}
function linkTokens(s) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    out.push({ t: 'link', v: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}
/** The text with the markup removed, for previews, notifications and exports. */
export function plainText(text) {
  return formatTokens(text).map((x) => (x.t === 'hide' ? '▒'.repeat(Math.min(8, x.v.length)) : x.v)).join('');
}

// ---------- export ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const two = (n) => String(n).padStart(2, '0');
const stamp = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
const who = (m, me) => (m.from === me ? 'You' : m.from);
const IMG_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function exportLine(m, me) {
  if (m.from === '@system') return `[${stamp(m.ts)}] — ${m.text}`;
  if (m.deleted) return `[${stamp(m.ts)}] ${who(m, me)}: (deleted)`;
  const bits = [];
  if (m.forwarded) bits.push('(forwarded)');
  if (m.reply) bits.push(`(reply to ${m.reply.from === me ? 'you' : m.reply.from}: “${m.reply.text}”)`);
  if (m.media) bits.push(`[${m.media.type === 'image' ? 'photo' : m.media.type === 'audio' ? 'voice message' : 'file'}: ${m.media.name || ''}]`);
  if (m.text) bits.push(m.text);
  if (m.edited) bits.push('(edited)');
  return `[${stamp(m.ts)}] ${who(m, me)}: ${bits.join(' ')}`;
}

/** Export a chat. format: 'txt' | 'html' | 'json'. Media data is kept only when `media` is true. */
export function exportChat({ name, me, thread, format = 'html', media = false, now = Date.now() }) {
  const list = (thread || []).map(({ out, anyQueued, okCopies, failedCopies, lastError, receiptSent, ...m }) => {
    if (m.media && (!media || m.once)) { const { data, ...rest } = m.media; return { ...m, media: rest }; } // never a view-once photo
    return m;
  });
  if (format === 'json') {
    return JSON.stringify({ app: 'FabriC++', exported: new Date(now).toISOString(), chat: name, me, messages: list }, null, 2);
  }
  if (format === 'txt') {
    return [`FabriC++ chat export — ${name}`, `Exported ${stamp(now)} by ${me}. ${list.length} messages.`, '', ...list.map((m) => exportLine(m, me))].join('\n') + '\n';
  }
  const rows = list.map((m) => {
    if (m.from === '@system') return `<li class="sys">${esc(stamp(m.ts))} · ${esc(m.text)}</li>`;
    const body = m.deleted ? '<em>deleted</em>' : [
      m.forwarded ? '<div class="note">Forwarded</div>' : '',
      m.reply ? `<blockquote>${esc(m.reply.from === me ? 'You' : m.reply.from)}: ${esc(m.reply.text)}</blockquote>` : '',
      m.media?.data && m.media.type === 'image' && IMG_MIME.has(m.media.mime) ? `<img alt="photo" src="data:${m.media.mime};base64,${esc(m.media.data)}">` : '',
      m.media && !(m.media.data && m.media.type === 'image') ? `<div class="note">[${esc(m.media.type === 'audio' ? 'voice message' : m.media.type === 'image' ? 'photo' : 'file')}: ${esc(m.media.name || '')}]</div>` : '',
      m.text ? `<p>${esc(plainText(m.text))}</p>` : '',
    ].join('');
    return `<li class="${m.from === me ? 'me' : ''}"><div class="who">${esc(who(m, me))} · ${esc(stamp(m.ts))}${m.edited ? ' · edited' : ''}</div>${body}</li>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(name)} · FabriC++ export</title><style>
body{margin:0;background:#fff;color:#111820;font:15px/1.5 "Helvetica Neue",Helvetica,Arial,sans-serif}
header{padding:28px 24px;border-bottom:1px solid #d6dce1}h1{margin:0;font-weight:400;font-size:28px;letter-spacing:-.03em}
.eyebrow{font:10px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.12em;text-transform:uppercase;color:#52606b}
ol{list-style:none;margin:0;padding:16px 24px;max-width:760px}li{padding:10px 0;border-bottom:1px solid #d6dce1}
li.me .who{color:#2454dd}.who{font-size:12px;color:#52606b}.sys{font:11px ui-monospace,Menlo,Consolas,monospace;color:#52606b;text-transform:uppercase}
p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}blockquote{margin:4px 0;padding-left:8px;border-left:2px solid #111820;color:#52606b}
img{max-width:320px;display:block;margin:4px 0}.note{font-size:12px;color:#52606b}
</style></head><body><header><div class="eyebrow">FabriC++ chat export</div><h1>${esc(name)}</h1>
<div class="eyebrow">Exported ${esc(stamp(now))} by ${esc(me)} · ${list.length} messages · decrypted on this device</div></header>
<ol>
${rows}
</ol></body></html>
`;
}
export function exportFileName(name, format, now = Date.now()) {
  const d = new Date(now);
  const base = String(name).replace(/^[@#~]/, '').replace(/\.veil$/, '').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'chat';
  return `fabric-${base}-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}.${format === 'txt' ? 'txt' : format}`;
}

// ---------- keyboard shortcuts ----------
// `mod` is Ctrl, or ⌘ on macOS.
export const SHORTCUTS = [
  { keys: 'mod+K', action: 'search', label: 'Search chats and messages' },
  { keys: 'mod+F', action: 'find', label: 'Search in this chat' },
  { keys: 'mod+J', action: 'date', label: 'Jump to a date in this chat' },
  { keys: 'alt+ArrowUp', action: 'prev', label: 'Previous chat' },
  { keys: 'alt+ArrowDown', action: 'next', label: 'Next chat' },
  { keys: 'mod+PageUp', action: 'prev', label: 'Previous chat' },
  { keys: 'mod+PageDown', action: 'next', label: 'Next chat' },
  { keys: 'mod+1…9', action: 'folder', label: 'Go to folder 1–9' },
  { keys: 'mod+0', action: 'saved', label: 'Saved messages' },
  { keys: 'ArrowUp', action: 'editLast', label: 'Edit your last message (empty message box)' },
  { keys: 'mod+shift+M', action: 'mute', label: 'Mute or unmute this chat' },
  { keys: 'mod+shift+E', action: 'export', label: 'Export this chat' },
  { keys: 'mod+,', action: 'settings', label: 'Settings' },
  { keys: 'mod+L', action: 'lock', label: 'Lock FabriC++ (needs a passphrase)' },
  { keys: 'mod+/', action: 'help', label: 'Show keyboard shortcuts' },
  { keys: 'Escape', action: 'escape', label: 'Close a menu, search or the chat' },
];
/**
 * The shortcut action for a keydown, or null. `ev` = { key, ctrlKey, metaKey, altKey, shiftKey },
 * `mac` swaps Ctrl for ⌘, `typing` is true while focus is in a text field with text in it.
 * Returns { action, n? }.
 */
export function shortcutFor(ev, { mac = false, typing = false, composerEmpty = true } = {}) {
  const mod = mac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey;
  const k = ev.key?.length === 1 ? ev.key.toUpperCase() : ev.key;
  if (mod && !ev.altKey) {
    if (ev.shiftKey) {
      if (k === 'M') return { action: 'mute' };
      if (k === 'E') return { action: 'export' };
      return null;
    }
    if (/^[1-9]$/.test(k)) return { action: 'folder', n: Number(k) };
    const map = { K: 'search', F: 'find', J: 'date', 0: 'saved', ',': 'settings', L: 'lock', '/': 'help', PageUp: 'prev', PageDown: 'next' };
    return map[k] ? { action: map[k] } : null;
  }
  if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
    if (k === 'ArrowUp') return { action: 'prev' };
    if (k === 'ArrowDown') return { action: 'next' };
  }
  if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && k === 'ArrowUp' && composerEmpty && !typing) return { action: 'editLast' };
  if (k === 'F1') return { action: 'help' };
  return null;
}
export const shortcutLabel = (keys, mac = false) => keys
  .replace(/mod\+/g, mac ? '⌘' : 'Ctrl+').replace(/shift\+/g, mac ? '⇧' : 'Shift+').replace(/alt\+/g, mac ? '⌥' : 'Alt+')
  .replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('Escape', 'Esc');

// ---------- auto-lock ----------
export const AUTOLOCK_CHOICES = [0, 1, 5, 15, 60]; // minutes; 0 = off
export const lockDue = (lastActive, minutes, now = Date.now()) => minutes > 0 && now - lastActive >= minutes * 60e3;

// ---------- multiple accounts ----------
export const PROFILE_RE = /^[a-z0-9-]{1,24}$/;
export const MAX_ACCOUNTS = 6;
/** Remember which account lives in which local profile. Returns the new list. */
export function noteAccount(list, profile, handle, now = Date.now()) {
  const rest = (Array.isArray(list) ? list : []).filter((a) => a && PROFILE_RE.test(a.profile) && a.profile !== profile);
  return [{ profile, handle: String(handle || ''), seen: now }, ...rest].slice(0, MAX_ACCOUNTS + 2);
}
