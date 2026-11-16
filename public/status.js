// Status updates (24 hours), broadcast lists and locked chats for the web client (and so the
// desktop and Android apps). Pure logic and the payload checks live in /shared/status.js.
//
// A status goes to each of your one-to-one chats as an end-to-end encrypted control message, like
// your profile photo. Viewers send back "seen" only if their read receipts are on. A broadcast is
// the same message sent as separate one-to-one messages. Locked chats are hidden from the chat
// list behind a code that never leaves this device (only a salted PBKDF2 hash of it is kept).
import {
  STATUS_TTL, MAX_STATUS_TEXT, MAX_STATUSES, STATUS_BGS, statusOf, expireStatuses, applyStatus, statusRows,
  statusAudience, cleanBroadcast, MAX_BROADCAST, lockHash, lockCheck, MIN_LOCK_CODE,
} from '/shared/status.js';

const MAX_AUDIENCE = 256;
const rid = (prefix, n) => prefix + [...crypto.getRandomValues(new Uint8Array(n))].map((b) => (b % 36).toString(36)).join('');

export function installStatus(api) {
  const { $, el, toast } = api;
  const db = () => api.db();
  const me = () => db()?.handle;
  const store = () => (db().status ??= { mine: [], from: {}, exclude: [] });

  function dialog(title, cls = '') {
    const d = el('dialog', 'fwd-dialog desk-dialog ' + cls);
    d.setAttribute('aria-label', title);
    if (title) d.append(el('h3', '', title));
    d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    document.body.append(d);
    return d;
  }
  function button(text, cls, onclick) { const b = el('button', cls, text); b.type = 'button'; if (onclick) b.onclick = onclick; return b; }
  function actions(...btns) { const r = el('div', 'dialog-actions'); r.append(...btns); return r; }
  const ago = (ts) => {
    const m = Math.round((Date.now() - ts) / 60e3);
    return m < 1 ? 'Just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
  };
  /** One-to-one chats with a device list, most recent first. */
  const people = () => api.chatKeys()
    .filter((h) => !api.isGroupKey(h) && h !== api.SAVED && db().contacts[h]?.list && !db().contacts[h].pendingAccount && !db().contacts[h].viaGroup)
    .sort((a, b) => api.lastTs(b) - api.lastTs(a));

  /** A checklist of people; resolves to the handles ticked, or null on Cancel. */
  function pickPeople(title, { selected = [], hint = '', ok = 'Done', min = 0 } = {}) {
    return new Promise((resolve) => {
      const d = dialog(title, 'st-pick');
      if (hint) d.append(el('p', 'muted small', hint));
      const ul = el('ul', 'fwd-list st-checks');
      const on = new Set(selected);
      const list = people();
      if (!list.length) ul.append(el('li', 'contacts-empty', 'No contacts yet. Start a chat with someone by their +name first.'));
      for (const h of list) {
        const li = el('li');
        const lab = el('label', 'st-check');
        const box = el('input');
        box.type = 'checkbox'; box.checked = on.has(h);
        box.onchange = () => { if (box.checked) on.add(h); else on.delete(h); };
        lab.append(box, api.avatarEl(h), el('span', 'contact-name', h));
        li.append(lab);
        ul.append(li);
      }
      let done = false;
      d.addEventListener('close', () => { if (!done) resolve(null); });
      d.append(ul, actions(button('Cancel', 'ghost', () => d.close()), button(ok, 'primary', () => {
        if (on.size < min) { toast(min === 1 ? 'Pick at least one person.' : `Pick at least ${min} people.`); return; }
        done = true; d.close(); resolve([...on]);
      })));
      d.showModal();
    });
  }

  // ======================= status =======================
  /** Send one status payload to everyone in `to`; my other devices get one copy. */
  async function sendToAll(to, payload) {
    let self = true;
    for (const h of to) {
      try { await api.sendControl(h, payload, { self }); self = false; } catch { /* they miss this one */ }
    }
    if (self) await api.sendControl(api.SAVED, payload, { self: true, only: 'self' }).catch(() => {});
  }

  async function postStatus(content) {
    const st = store();
    expireStatuses(st);
    if (st.mine.length >= MAX_STATUSES) { toast(`Up to ${MAX_STATUSES} at a time. Delete one first.`); return; }
    const audience = statusAudience(people(), { blocked: db().blocked || {}, exclude: st.exclude || [], isBot: api.isBotHandle }).slice(0, MAX_AUDIENCE);
    const sid = rid('s', 14);
    const payload = { kind: 'status', sid, ...content };
    if (!statusOf(payload)) { toast('Nothing to post.'); return; }
    st.mine.push({ sid, ...content, ts: Date.now(), to: audience, seenBy: {} });
    await api.persist();
    renderStrip();
    toast(audience.length ? `Posted · ${audience.length} contact${audience.length === 1 ? '' : 's'} can see it for 24 hours` : 'Posted · nobody can see it yet');
    await sendToAll(audience, payload);
  }

  async function deleteStatus(sid) {
    const st = store();
    const i = st.mine.findIndex((s) => s.sid === sid);
    if (i < 0) return;
    const [s] = st.mine.splice(i, 1);
    await api.persist();
    renderStrip();
    await sendToAll(s.to || [], { kind: 'status', sid, del: true });
  }

  /** A `status` or `status_seen` payload; `from` is null when it came from my other device. */
  function onPayload(payload, from, ts) {
    const st = store();
    if (payload.kind === 'status_seen') {
      if (!from || typeof payload.sid !== 'string') return;
      const mine = st.mine.find((s) => s.sid === payload.sid);
      if (!mine || !(mine.to || []).includes(from) || mine.seenBy?.[from]) return;
      (mine.seenBy ??= {})[from] = ts;
      api.persist().catch(() => {});
      return;
    }
    const s = statusOf(payload);
    if (!s) return;
    if (!from) { // posted or deleted on my other device
      const i = st.mine.findIndex((x) => x.sid === s.sid);
      if (s.del) { if (i >= 0) st.mine.splice(i, 1); } else if (i < 0 && Date.now() - ts < STATUS_TTL) st.mine.push({ ...s, ts, to: [], seenBy: {} });
    } else {
      if (db().blocked?.[from] || !db().contacts[from] || db().contacts[from].viaGroup) return;
      if (!applyStatus(st, from, s, Math.min(ts, Date.now()))) return;
    }
    api.persist().catch(() => {});
    renderStrip();
  }

  // ---------- the strip at the top of the chat list ----------
  const strip = el('div', 'st-strip');
  strip.setAttribute('role', 'list');
  strip.setAttribute('aria-label', 'Status updates');
  function ring(h, cls, label, onclick) {
    const b = button('', 'st-ring ' + cls, onclick);
    b.setAttribute('role', 'listitem');
    b.append(api.avatarEl(h), el('span', 'st-name', label));
    return b;
  }
  function renderStrip() {
    if (!db()?.handle) return;
    const st = store();
    if (expireStatuses(st)) api.persist().catch(() => {});
    strip.replaceChildren();
    const mineN = st.mine.length;
    const my = ring(me(), mineN ? 'mine has' : 'mine', mineN ? 'My status' : 'Add status', () => (mineN ? openViewer(me(), st.mine, true) : openAdd()));
    if (!mineN) my.append(el('span', 'st-plus', '+'));
    strip.append(my);
    if (mineN) strip.append(Object.assign(button('+', 'st-add', () => openAdd()), { title: 'Add a status' }));
    for (const r of statusRows(st)) {
      if (db().blocked?.[r.handle] || isLocked(r.handle)) continue;
      strip.append(ring(r.handle, r.unseen ? 'unseen' : 'seen', api.chatName(r.handle).replace(/^@/, '').replace(/\.veil$/, ''), () => openViewer(r.handle, r.list, false)));
    }
  }

  // ---------- add a status: text on a colour, or a photo ----------
  const photoIn = el('input');
  photoIn.type = 'file'; photoIn.accept = 'image/*'; photoIn.hidden = true;
  document.body.append(photoIn);
  photoIn.onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const media = await api.imageMedia(f);
      openPhotoCaption(media);
    } catch (err) { toast(err.message || 'Could not use that photo.'); }
  };

  function audienceLine() {
    const ex = (store().exclude || []).length;
    return ex ? `All your contacts except ${ex}` : 'All your contacts';
  }
  function privacyRow(onChange) {
    const row = el('div', 'st-privacy');
    const label = el('span', 'muted small', 'Who sees it: ' + audienceLine());
    row.append(label, button('Change', 'ghost small', async () => {
      const picked = await pickPeople('Hide my status from', { selected: store().exclude || [], hint: 'People you tick won’t get your status updates.', ok: 'Save' });
      if (!picked) return;
      store().exclude = picked;
      await api.persist();
      label.textContent = 'Who sees it: ' + audienceLine();
      onChange?.();
    }));
    return row;
  }

  function openAdd() {
    const d = dialog('New status', 'st-add-dialog');
    let bg = STATUS_BGS[0];
    const card = el('div', 'st-compose');
    card.style.background = bg;
    const ta = el('textarea', 'st-text');
    ta.maxLength = MAX_STATUS_TEXT; ta.placeholder = 'Type a status'; ta.rows = 4; ta.setAttribute('aria-label', 'Status text');
    card.append(ta);
    const swatches = el('div', 'st-swatches');
    for (const c of STATUS_BGS) {
      const s = button('', 'st-swatch', () => { bg = c; card.style.background = c; swatches.querySelectorAll('.st-swatch').forEach((x) => x.classList.toggle('on', x === s)); });
      s.style.background = c; s.setAttribute('aria-label', 'Background colour');
      if (c === bg) s.classList.add('on');
      swatches.append(s);
    }
    d.append(card, swatches, privacyRow(), actions(
      button('Photo…', 'ghost', () => { d.close(); photoIn.click(); }),
      button('Cancel', 'ghost', () => d.close()),
      button('Post', 'primary', () => {
        const text = ta.value.trim();
        if (!text) { toast('Type something, or choose Photo.'); return; }
        d.close();
        postStatus({ text, bg });
      })));
    d.showModal();
    ta.focus();
  }

  function openPhotoCaption(media) {
    const d = dialog('New status', 'st-add-dialog');
    const img = el('img', 'st-preview');
    img.alt = 'Your photo';
    img.src = `data:${media.mime};base64,${media.data}`;
    const cap = el('input', 'text-input');
    cap.maxLength = MAX_STATUS_TEXT; cap.placeholder = 'Add a caption'; cap.setAttribute('aria-label', 'Caption');
    d.append(img, cap, privacyRow(), actions(button('Cancel', 'ghost', () => d.close()), button('Post', 'primary', () => {
      d.close();
      const text = cap.value.trim();
      postStatus({ ...(text ? { text } : {}), media: { type: 'image', mime: media.mime, data: media.data, ...(media.w ? { w: media.w, h: media.h } : {}) } });
    })));
    d.showModal();
  }

  // ---------- viewer ----------
  const SHOW_MS = 6000;
  function openViewer(h, list, mine) {
    if (!list?.length) return;
    let i = mine ? 0 : Math.max(0, list.findIndex((s) => !s.seen));
    let timer = null;
    const d = dialog('', 'st-viewer');
    d.setAttribute('aria-label', mine ? 'My status' : `Status from ${h}`);
    const bars = el('div', 'st-bars');
    const head = el('div', 'st-head');
    const stage = el('div', 'st-stage');
    const foot = el('div', 'st-foot');
    d.append(bars, head, stage, foot);
    const close = () => d.close();
    d.addEventListener('close', () => { clearTimeout(timer); renderStrip(); });
    const go = (n) => { if (n < 0) n = 0; if (n >= list.length) { close(); return; } i = n; draw(); };
    stage.onclick = (e) => { const r = stage.getBoundingClientRect(); go(e.clientX - r.left < r.width / 3 ? i - 1 : i + 1); };
    d.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') go(i + 1); if (e.key === 'ArrowLeft') go(i - 1); });
    function draw() {
      clearTimeout(timer);
      const s = list[i];
      if (!s) { close(); return; }
      bars.replaceChildren(...list.map((_, k) => el('span', 'st-bar' + (k < i ? ' done' : k === i ? ' now' : ''))));
      bars.querySelector('.now')?.style.setProperty('--st-ms', `${SHOW_MS}ms`);
      head.replaceChildren(api.avatarEl(h), el('div', 'st-who', mine ? 'My status' : h), el('span', 'st-when', ago(s.ts)), button('✕', 'icon-btn st-close', close));
      stage.replaceChildren();
      stage.style.background = s.media ? '#000' : (s.bg || STATUS_BGS[0]);
      if (s.media?.data) {
        const img = el('img', 'st-img');
        img.alt = s.text || 'Status photo';
        img.src = `data:${s.media.mime};base64,${s.media.data}`; // mime checked against an image allowlist (shared/status.js)
        stage.append(img);
        if (s.text) stage.append(el('div', 'st-caption', s.text));
      } else stage.append(el('div', 'st-big', s.text || ''));
      foot.replaceChildren();
      if (mine) {
        const seen = Object.entries(s.seenBy || {}).sort((a, b) => b[1] - a[1]);
        const seenBtn = button(`Seen by ${seen.length}`, 'ghost small', () => {
          clearTimeout(timer);
          const sd = dialog(`Seen by ${seen.length}`);
          const ul = el('ul', 'fwd-list');
          if (!seen.length) ul.append(el('li', 'contacts-empty', (s.to || []).length ? 'Nobody yet. People with read receipts off aren’t shown.' : 'Sent from another device: views show there.'));
          for (const [who, t] of seen) { const li = el('li', 'sched-row'); li.append(api.avatarEl(who), el('span', 'contact-name', who), el('span', 'muted small', ago(t))); ul.append(li); }
          sd.append(ul, actions(button('Close', 'ghost', () => sd.close())));
          sd.showModal();
        });
        foot.append(seenBtn, button('Delete', 'ghost small danger', async () => { close(); await deleteStatus(s.sid); toast('Status deleted'); }));
      } else {
        foot.append(button('Reply', 'ghost small', () => { close(); api.openThread(h).then(() => { const t = $('text'); t.value = `Re your status: “${(s.text || 'photo').slice(0, 60)}” `; api.growText(); t.focus(); }); }));
        if (!s.seen) {
          s.seen = true;
          api.persist().catch(() => {});
          if (api.userPrefs().receipts !== false) api.sendControl(h, { kind: 'status_seen', sid: s.sid }, { self: false }).catch(() => {});
        }
      }
      timer = setTimeout(() => go(i + 1), SHOW_MS);
    }
    draw();
    d.showModal();
  }

  // ======================= broadcast lists =======================
  const lists = () => (db().broadcasts ??= []);
  function openBroadcasts() {
    const d = dialog('Broadcast lists');
    d.append(el('p', 'muted small', 'Send one message to many people. Each person gets it as a normal one-to-one message and doesn’t see who else got it.'));
    const ul = el('ul', 'fwd-list');
    const draw = () => {
      ul.replaceChildren();
      if (!lists().length) ul.append(el('li', 'contacts-empty', 'No broadcast lists yet.'));
      for (const b of lists()) {
        const li = el('li', 'sched-row');
        const open = button('', 'st-list', () => { d.close(); openBroadcastCompose(b); });
        open.append(el('span', 'contact-name', b.name), el('small', 'muted', `${b.members.length} recipient${b.members.length === 1 ? '' : 's'}`));
        li.append(open, button('Edit', 'ghost small', async () => { await editBroadcast(b); draw(); }),
          button('Delete', 'ghost small danger', async () => { db().broadcasts = lists().filter((x) => x.id !== b.id); await api.persist(); draw(); }));
        ul.append(li);
      }
    };
    draw();
    d.append(ul, actions(button('Close', 'ghost', () => d.close()), button('New list', 'primary', async () => {
      const b = await editBroadcast(null);
      if (b) { d.close(); openBroadcastCompose(b); }
    })));
    d.showModal();
  }
  async function editBroadcast(b) {
    const members = await pickPeople(b ? `Edit ${b.name}` : 'New broadcast list', { selected: b?.members || [], ok: 'Next', min: 2 });
    if (!members) return null;
    const name = await askName(b?.name || '');
    if (name === null) return null;
    const next = cleanBroadcast({ id: b?.id || rid('b', 10), name, members: members.slice(0, MAX_BROADCAST) });
    if (!next) return null;
    const all = lists();
    const i = all.findIndex((x) => x.id === next.id);
    if (i >= 0) all[i] = next; else all.push(next);
    await api.persist();
    return next;
  }
  function askName(initial) {
    return new Promise((resolve) => {
      const d = dialog('Name this list', 'st-name-dialog');
      const f = el('form');
      const input = el('input', 'text-input');
      input.maxLength = 60; input.value = initial; input.placeholder = 'e.g. Team'; input.setAttribute('aria-label', 'List name');
      let done = false;
      f.onsubmit = (e) => { e.preventDefault(); done = true; d.close(); resolve(input.value.trim()); };
      const ok = button('Save', 'primary');
      ok.type = 'submit';
      f.append(input, actions(button('Cancel', 'ghost', () => d.close()), ok));
      d.append(f);
      d.addEventListener('close', () => { if (!done) resolve(null); });
      d.showModal();
      input.focus();
    });
  }
  function openBroadcastCompose(b) {
    const d = dialog(b.name, 'st-bc');
    d.append(el('p', 'muted small', `To ${b.members.length}: ${b.members.slice(0, 6).join(', ')}${b.members.length > 6 ? '…' : ''}`));
    const ta = el('textarea', 'text-input st-bc-text');
    ta.rows = 4; ta.maxLength = 4000; ta.placeholder = 'Message'; ta.setAttribute('aria-label', 'Broadcast message');
    const status = el('p', 'muted small');
    const send = button('Send to all', 'primary', async () => {
      const text = ta.value.trim();
      if (!text) return;
      send.disabled = true;
      let n = 0;
      for (const h of b.members) {
        if (db().blocked?.[h]) continue;
        status.textContent = `Sending ${++n} of ${b.members.length}…`;
        try { await api.sendText(text, null, {}, h); } catch { /* that one shows as failed in its chat */ }
      }
      d.close();
      toast(`Sent to ${n} chat${n === 1 ? '' : 's'}`);
    });
    d.append(ta, status, actions(button('Cancel', 'ghost', () => d.close()), send));
    d.showModal();
    ta.focus();
  }

  // ======================= locked chats =======================
  let unlocked = false; // until the app goes to the background
  let showLocked = false;
  const isLocked = (k) => Boolean(k && api.prefsOf()[k]?.locked);
  const lockedKeys = () => api.chatKeys().filter(isLocked);

  function askCode(title, { confirm = false, hint = '' } = {}) {
    return new Promise((resolve) => {
      const d = dialog(title, 'st-code');
      if (hint) d.append(el('p', 'muted small', hint));
      const f = el('form');
      const a = el('input', 'text-input');
      a.type = 'password'; a.inputMode = 'numeric'; a.autocomplete = 'off'; a.placeholder = 'Secret code'; a.setAttribute('aria-label', 'Secret code');
      const b = el('input', 'text-input');
      b.type = 'password'; b.inputMode = 'numeric'; b.autocomplete = 'off'; b.placeholder = 'Again'; b.setAttribute('aria-label', 'Secret code again');
      f.append(a);
      if (confirm) f.append(b);
      let done = false;
      f.onsubmit = (e) => {
        e.preventDefault();
        if (a.value.length < MIN_LOCK_CODE) { toast(`At least ${MIN_LOCK_CODE} characters.`); return; }
        if (confirm && a.value !== b.value) { toast('The codes don’t match.'); return; }
        done = true; d.close(); resolve(a.value);
      };
      const ok = button('OK', 'primary');
      ok.type = 'submit';
      f.append(actions(button('Cancel', 'ghost', () => d.close()), ok));
      d.append(f);
      d.addEventListener('close', () => { if (!done) resolve(null); });
      d.showModal();
      a.focus();
    });
  }
  async function unlock() {
    if (unlocked) return true;
    const code = await askCode('Locked chats', { hint: 'Enter your secret code.' });
    if (code === null) return false;
    if (!(await lockCheck(code, db().chatLock))) { toast('Wrong code.'); return false; }
    unlocked = true;
    return true;
  }
  async function toggleLock(key) {
    if (!key || key === api.SAVED) return;
    if (isLocked(key)) {
      if (!(await unlock())) return;
      api.setChatPref(key, 'locked', false);
      if (!lockedKeys().length) showLocked = false;
      api.renderContacts();
      toast('Chat unlocked');
      return;
    }
    if (!db().chatLock) {
      const code = await askCode('Set a secret code', { confirm: true, hint: 'Locked chats move out of your chat list. You open them with this code. It stays on this device and can’t be recovered, so pick one you’ll remember.' });
      if (code === null) return;
      db().chatLock = await lockHash(code);
      unlocked = true;
    } else if (!(await unlock())) return;
    api.setChatPref(key, 'locked', true);
    if (api.active() === key && !showLocked) api.closeThread();
    api.renderContacts();
    toast('Chat locked · find it under Locked chats');
  }
  /** The chats the list shows: without locked ones, or only those while "Locked chats" is open. */
  function filterChats(keys) {
    if (showLocked && unlocked) return keys.filter(isLocked);
    return keys.filter((k) => !isLocked(k));
  }
  /** Rows above the chat list: the status strip and "Locked chats". */
  function renderTop(ul, { searching = false, archived = false } = {}) {
    if (!searching && !archived && !showLocked) { renderStrip(); const li = el('li', 'st-strip-row'); li.append(strip); ul.append(li); }
    const n = lockedKeys().length;
    if (archived || (!n && !showLocked)) return;
    const row = el('li', 'archived-row st-locked-row');
    row.append(el('span', '', showLocked ? '← Back to chats' : `🔒 Locked chats · ${n}`));
    row.onclick = async () => {
      if (showLocked) { showLocked = false; api.renderContacts(); return; }
      if (await unlock()) { showLocked = true; api.renderContacts(); }
    };
    ul.append(row);
  }
  /** Opening a locked chat (from search, a notification, a link) asks for the code first. */
  async function mayOpen(key) { return !isLocked(key) || unlock(); }
  const lockItem = el('button', '', 'Lock chat');
  lockItem.type = 'button'; lockItem.id = 'chat-lock'; lockItem.setAttribute('role', 'menuitem');
  lockItem.onclick = () => { const k = api.menuChat(); api.closeChatMenu(); toggleLock(k); };
  $('chat-delete').before(lockItem);
  function onChatMenu(key) {
    lockItem.classList.toggle('hidden', !key || key === api.SAVED);
    lockItem.textContent = isLocked(key) ? 'Unlock chat' : 'Lock chat';
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !unlocked) return;
    unlocked = false; // locked again once you leave the app
    showLocked = false;
    if (isLocked(api.active())) api.closeThread(); else api.renderContacts();
  });

  // ---------- the New sheet: broadcast lists, status ----------
  const sheet = $('new-sheet');
  const sep = sheet?.querySelector('.sheet-sep');
  if (sep) {
    const item = (key, title, sub, svg) => {
      const b = el('button', 'sheet-item');
      b.type = 'button';
      const ico = el('span', 'sheet-ico');
      ico.innerHTML = svg; // constant markup, no user data
      const txt = el('span');
      txt.append(el('strong', '', title), el('small', '', sub));
      b.append(ico, txt);
      b.onclick = () => { sheet.close(); if (key === 'bc') openBroadcasts(); else openAdd(); };
      sep.before(b);
    };
    item('bc', 'Broadcast list', 'One message, sent to each person separately', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l6 4V6L7 10zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/></svg>');
    item('st', 'Status', 'Text or photo · gone after 24 hours', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke-dasharray="4 2.3"/><path d="M12 8v8M8 12h8"/></svg>');
  }

  setInterval(() => { if (db()?.status && expireStatuses(db().status)) { api.persist().catch(() => {}); renderStrip(); } }, 60e3);

  return { onPayload, renderTop, filterChats, mayOpen, onChatMenu, isLocked: (k) => isLocked(k) && !unlocked, isLockedAny: isLocked, openAdd, openBroadcasts };
}
