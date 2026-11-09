// Desktop-class features for the web client (and so for the desktop and Android apps, which load
// this page): chat folders, Saved messages, drafts, scheduled and silent sends, timed mutes, a media
// viewer and shared-media browser, jump to date, message formatting, chat export, keyboard
// shortcuts, appearance, notification options, auto-lock, several accounts, picture-in-picture and
// the desktop app's own settings. Pure logic lives in /shared/desk.js.
import {
  SAVED, BUILTIN_FOLDERS, MAX_FOLDERS, inFolder, cleanFolder, MUTE_CHOICES, expireMutes, muteLabel,
  dueScheduled, validScheduleTime, MAX_SCHEDULED, sharedOf, messageOnDay, formatTokens, plainText,
  exportChat, exportFileName, SHORTCUTS, shortcutFor, shortcutLabel, AUTOLOCK_CHOICES, lockDue,
  MAX_ACCOUNTS, noteAccount,
} from '/shared/desk.js';

export { SAVED, plainText };

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } },
};

// ---------- appearance: applied at import, before the vault opens ----------
const APPEAR_KEY = 'fabric-appearance';
const APPEAR_DEFAULT = { size: 'm', bg: 'plain', compact: false };
export function applyAppearance(a = store.get(APPEAR_KEY, APPEAR_DEFAULT)) {
  const r = document.documentElement;
  r.dataset.textSize = ['s', 'm', 'l', 'xl'].includes(a.size) ? a.size : 'm';
  r.dataset.chatBg = ['plain', 'grid', 'dots', 'rule'].includes(a.bg) ? a.bg : 'plain';
  r.toggleAttribute('data-compact', Boolean(a.compact));
}
applyAppearance();

/** Called once from app.js, after its own handlers are bound. */
export function installDesk(api) {
  const { $, el, toast } = api;
  const db = () => api.db();
  const active = () => api.active();
  const prefs = () => api.prefsOf();
  const uprefs = () => api.userPrefs();
  const desktop = window.FabricDesktop || null;

  // ---------- small UI kit: dialogs built in code, house style ----------
  function dialog(title, { cls = '' } = {}) {
    const d = el('dialog', 'fwd-dialog desk-dialog ' + cls);
    d.setAttribute('aria-label', title);
    d.append(el('h3', '', title));
    d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    document.body.append(d);
    return d;
  }
  function button(text, cls, onclick) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (onclick) b.onclick = onclick;
    return b;
  }
  function actions(...btns) { const r = el('div', 'dialog-actions'); r.append(...btns); return r; }
  function choose(title, options) {
    return new Promise((resolve) => {
      const d = dialog(title);
      const ul = el('div', 'choice-list');
      for (const o of options) ul.append(button(o.label, 'choice', () => { resolve(o); d.close(); }));
      d.append(ul, actions(button('Cancel', 'ghost', () => d.close())));
      d.addEventListener('close', () => resolve(null));
      d.showModal();
    });
  }
  function check(label, checked, hint) {
    const l = el('label', 'pref');
    const i = el('input'); i.type = 'checkbox'; i.checked = Boolean(checked);
    const s = el('span', '', label);
    if (hint) s.append(el('small', '', hint));
    l.append(i, s);
    return { label: l, input: i };
  }
  function select(label, options, value) {
    const l = el('label', 'pref pref-select');
    const s = el('select');
    for (const [v, t] of options) { const o = el('option', '', t); o.value = String(v); s.append(o); }
    s.value = String(value);
    l.append(el('span', '', label), s);
    return { label: l, input: s };
  }
  const download = (name, text, type) => {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  };

  // ---------- chat folders ----------
  const FOLDER_KEY = `fabric-folder-${api.profile}`;
  let folderId = store.get(FOLDER_KEY, 'all');
  const folders = () => [...BUILTIN_FOLDERS, ...(db().folders || []).map(cleanFolder).filter(Boolean)];
  const folderNow = () => folders().find((f) => f.id === folderId) || BUILTIN_FOLDERS[0];
  const infoOf = (key) => ({ group: api.isGroupKey(key), unread: db().unread?.[key] || 0, muted: Boolean(prefs()[key]?.muted) });
  const matches = (key) => inFolder(folderNow(), key, infoOf(key));
  function setFolder(id) { folderId = id; store.set(FOLDER_KEY, id); api.renderContacts(); }

  function renderFolders(keys) {
    let nav = $('folders');
    if (!nav) {
      nav = el('nav', 'folders');
      nav.id = 'folders';
      nav.setAttribute('aria-label', 'Chat folders');
      $('contacts').before(nav);
    }
    nav.replaceChildren();
    for (const f of folders()) {
      const n = keys.filter((k) => !prefs()[k]?.muted && db().unread?.[k] && inFolder(f, k, infoOf(k))).length;
      const b = button(f.name, 'folder' + (f.id === folderNow().id ? ' active' : ''), () => setFolder(f.id));
      b.dataset.folder = f.id;
      if (n) b.append(el('span', 'folder-n', String(n)));
      nav.append(b);
    }
    const edit = button('Edit', 'folder folder-edit', openFolders);
    edit.title = 'Edit chat folders';
    nav.append(edit);
  }

  function openFolders() {
    const d = dialog('Chat folders');
    const list = el('ul', 'fwd-list');
    const custom = (db().folders || []).map(cleanFolder).filter(Boolean);
    if (!custom.length) list.append(el('li', 'contacts-empty', 'No folders of your own yet. All, Unread, Personal and Groups are always there.'));
    for (const f of custom) {
      const li = el('li', 'folder-row');
      li.append(el('span', 'contact-name', f.name), button('Edit', 'ghost', () => { d.close(); editFolder(f); }),
        button('Delete', 'ghost', () => {
          db().folders = (db().folders || []).filter((x) => x.id !== f.id);
          if (folderId === f.id) folderId = 'all';
          api.persist(); api.renderContacts(); d.close(); toast(`Folder “${f.name}” deleted`);
        }));
      list.append(li);
    }
    const add = button('New folder', 'primary', () => { d.close(); editFolder(null); });
    add.disabled = custom.length >= MAX_FOLDERS;
    d.append(list, actions(button('Close', 'ghost', () => d.close()), add));
    d.showModal();
  }

  function editFolder(f) {
    const d = dialog(f ? `Edit “${f.name}”` : 'New folder');
    const name = el('input', 'text-input'); name.maxLength = 24; name.value = f?.name || ''; name.placeholder = 'Work';
    const nameRow = el('label', 'field'); nameRow.append(el('span', '', 'Name'), name);
    const types = [['personal', 'Personal chats'], ['groups', 'Groups'], ['unread', 'Unread chats']].map(([v, t]) => {
      const c = check(t, f?.types?.includes(v)); c.input.value = v; return c;
    });
    const hide = check('Leave out muted chats', f?.hideMuted);
    const pick = el('ul', 'fwd-list pick-list');
    for (const k of api.chatKeys()) {
      const l = el('label', 'pick');
      const i = el('input'); i.type = 'checkbox'; i.value = k; i.checked = Boolean(f?.chats?.includes(k));
      l.append(i, api.chatAvatar(k), el('span', 'contact-name', api.chatName(k)));
      const li = el('li'); li.append(l); pick.append(li);
    }
    const err = el('p', 'error small');
    const save = button(f ? 'Save' : 'Create folder', 'primary', () => {
      const next = cleanFolder({
        id: f?.id || 'f' + crypto.getRandomValues(new Uint32Array(2)).reduce((s, x) => s + x.toString(36), '').slice(0, 10),
        name: name.value, types: types.filter((t) => t.input.checked).map((t) => t.input.value),
        chats: [...pick.querySelectorAll('input:checked')].map((i) => i.value), exclude: f?.exclude || [], hideMuted: hide.input.checked,
      });
      if (!next) { err.textContent = 'Give the folder a name.'; return; }
      if (!next.types.length && !next.chats.length) { err.textContent = 'Pick at least one kind of chat or one chat.'; return; }
      db().folders = [...(db().folders || []).filter((x) => x.id !== next.id), next];
      folderId = next.id; store.set(FOLDER_KEY, folderId);
      api.persist(); api.renderContacts(); d.close();
    });
    d.append(nameRow, el('div', 'eyebrow', 'Include'), ...types.map((t) => t.label), hide.label, el('div', 'eyebrow', 'And these chats'), pick, err,
      actions(button('Cancel', 'ghost', () => d.close()), save));
    d.showModal();
    name.focus();
  }

  // ---------- drafts ----------
  let draftTimer = 0;
  function saveDraft(key = active()) {
    if (!key) return;
    const t = $('text').value;
    const drafts = (db().drafts ??= {});
    if (api.composeMode() === 'edit' || !t.trim()) delete drafts[key]; else drafts[key] = t.slice(0, 4000);
  }
  function restoreDraft(key) {
    $('text').value = db().drafts?.[key] || '';
    api.growText();
  }
  function clearDraft(key) { if (db().drafts?.[key]) { delete db().drafts[key]; api.persist(); } }
  $('text').addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { saveDraft(); api.persist(); }, 600);
  });
  const draftOf = (key) => (key !== active() ? db().drafts?.[key] : '') || '';

  // ---------- timed mutes ----------
  async function muteChat(key) {
    if (!key) return;
    if (prefs()[key]?.muted) { api.setChatPref(key, 'muted', false); delete prefs()[key].mutedUntil; api.persist(); toast('Notifications on'); return; }
    const c = await choose(`Mute ${api.chatName(key)}`, MUTE_CHOICES);
    if (!c) return;
    api.setChatPref(key, 'muted', true);
    if (c.ms) prefs()[key].mutedUntil = Date.now() + c.ms; else delete prefs()[key].mutedUntil;
    api.persist(); api.renderContacts(); api.renderThreadHead();
    toast(c.ms ? `Muted ${c.label.toLowerCase()}` : 'Muted');
  }
  $('mute-chat').onclick = () => muteChat(active());
  $('chat-mute').onclick = () => { const k = api.menuChat(); api.closeChatMenu(); muteChat(k); };
  function sweepMutes() {
    if (db().handle && expireMutes(prefs())) { api.persist(); api.renderContacts(); if (active()) api.renderThreadHead(); }
  }
  setInterval(sweepMutes, 30e3);

  // ---------- send options: silently, or at a time ----------
  const sendMenu = el('div', 'msg-menu hidden');
  sendMenu.id = 'send-menu';
  sendMenu.setAttribute('role', 'menu');
  sendMenu.append(
    button('Send without sound', '', () => { closeSendMenu(); sendNow({ silent: true }); }),
    button('Schedule message…', '', () => { closeSendMenu(); openSchedule(); }),
  );
  for (const b of sendMenu.children) b.setAttribute('role', 'menuitem');
  document.body.append(sendMenu);
  function closeSendMenu() { sendMenu.classList.add('hidden'); }
  function openSendMenu(x, y) {
    if (!active() || !$('text').value.trim() || api.composeMode() === 'edit') return;
    sendMenu.classList.remove('hidden');
    const r = sendMenu.getBoundingClientRect();
    sendMenu.style.left = `${Math.max(8, Math.min(x - r.width, innerWidth - r.width - 8))}px`;
    sendMenu.style.top = `${Math.max(8, y - r.height - 8)}px`;
    sendMenu.firstChild.focus();
  }
  const sendBtn = document.querySelector('#composer .send-btn');
  sendBtn.title = 'Send (right-click or hold for more)';
  sendBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); openSendMenu(e.clientX, e.clientY); });
  let holdTimer = 0;
  sendBtn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    holdTimer = setTimeout(() => { holdTimer = 0; navigator.vibrate?.(15); const r = sendBtn.getBoundingClientRect(); openSendMenu(r.right, r.top); }, 500);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) sendBtn.addEventListener(ev, () => clearTimeout(holdTimer));
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#send-menu')) closeSendMenu(); }, true);

  function sendNow(extra) {
    const t = $('text').value.trim();
    const to = active();
    if (!t || !to) return;
    $('text').value = ''; api.growText(); clearDraft(to);
    api.sendText(t, null, { ...api.replyExtra(), ...extra }, to);
  }

  function openSchedule() {
    const to = active();
    const text = $('text').value.trim();
    if (!to || !text) return;
    const d = dialog('Schedule message');
    const when = el('input', 'text-input');
    when.type = 'datetime-local';
    const local = (ts) => { const x = new Date(ts - new Date(ts).getTimezoneOffset() * 60e3); return x.toISOString().slice(0, 16); };
    when.value = local(Date.now() + 3600e3);
    when.min = local(Date.now() + 60e3);
    const quick = el('div', 'row');
    const at = (h, plusDay) => { const x = new Date(); if (plusDay) x.setDate(x.getDate() + 1); x.setHours(h, 0, 0, 0); return x.getTime(); };
    quick.append(
      button('In 1 hour', 'ghost', () => { when.value = local(Date.now() + 3600e3); }),
      button('Tonight 20:00', 'ghost', () => { when.value = local(at(20) > Date.now() + 60e3 ? at(20) : at(20, true)); }),
      button('Tomorrow 09:00', 'ghost', () => { when.value = local(at(9, true)); }),
    );
    const silent = check('Send without sound');
    const row = el('label', 'field'); row.append(el('span', '', 'Send at'), when);
    const err = el('p', 'error small');
    d.append(el('p', 'muted small', `“${plainText(text).slice(0, 80)}” to ${api.chatName(to)}`), row, quick, silent.label,
      el('p', 'muted small', 'This device sends it at that time, encrypted as usual. Keep FabriC++ open then: the desktop app keeps running in the tray.'),
      err, actions(button('Cancel', 'ghost', () => d.close()), button('Schedule', 'primary', () => {
        const ts = new Date(when.value).getTime();
        if (!validScheduleTime(ts)) { err.textContent = 'Pick a time at least a minute from now and within a year.'; return; }
        if ((db().scheduled || []).length >= MAX_SCHEDULED) { err.textContent = `Up to ${MAX_SCHEDULED} scheduled messages.`; return; }
        (db().scheduled ??= []).push({ id: crypto.randomUUID(), to, text, at: ts, ...(silent.input.checked ? { silent: true } : {}) });
        $('text').value = ''; api.growText(); clearDraft(to);
        api.persist(); renderThreadExtras(); d.close();
        toast(`Scheduled for ${new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`);
      })));
    d.showModal();
  }

  async function runScheduled() {
    if (!db().handle || !db().scheduled?.length) return;
    const { due, later } = dueScheduled(db().scheduled);
    if (!due.length) return;
    db().scheduled = later;
    await api.persist();
    for (const s of due) await api.sendText(s.text, null, s.silent ? { silent: true } : {}, s.to).catch(() => {});
    renderThreadExtras();
  }
  setInterval(runScheduled, 10e3);

  function openScheduledList() {
    const to = active();
    const d = dialog('Scheduled messages');
    const ul = el('ul', 'fwd-list');
    const draw = () => {
      ul.replaceChildren();
      const mine = (db().scheduled || []).filter((s) => s.to === to).sort((a, b) => a.at - b.at);
      if (!mine.length) { ul.append(el('li', 'contacts-empty', 'Nothing scheduled in this chat.')); return; }
      for (const s of mine) {
        const li = el('li', 'sched-row');
        const info = el('div', 'contact-main');
        info.append(el('div', 'contact-time', new Date(s.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + (s.silent ? ' · without sound' : '')),
          el('div', 'preview', plainText(s.text)));
        li.append(info,
          button('Send now', 'ghost', () => { s.at = 0; runScheduled(); d.close(); }),
          button('Delete', 'ghost', () => { db().scheduled = db().scheduled.filter((x) => x !== s); api.persist(); draw(); renderThreadExtras(); }));
        ul.append(li);
      }
    };
    draw();
    d.append(ul, actions(button('Close', 'ghost', () => d.close())));
    d.showModal();
  }

  // the bar over the composer: scheduled messages in this chat
  const schedBar = el('button', 'sched-bar hidden');
  schedBar.type = 'button';
  schedBar.id = 'sched-bar';
  schedBar.onclick = openScheduledList;
  $('composer').before(schedBar);
  function renderThreadExtras() {
    const n = (db().scheduled || []).filter((s) => s.to === active()).length;
    schedBar.classList.toggle('hidden', !n);
    schedBar.textContent = n ? `${n} scheduled message${n > 1 ? 's' : ''} · show` : '';
    const saved = active() === SAVED;
    for (const id of ['translate-toggle', 'show-safety']) $(id)?.classList.toggle('hidden', saved || (id === 'show-safety' && api.isGroupKey(active())));
  }

  // ---------- thread menu: shared media, jump to date, export ----------
  const menu = $('thread-menu');
  const addItem = (id, text, onclick, before = $('mute-chat')) => {
    const b = button(text, '', onclick);
    b.id = id; b.setAttribute('role', 'menuitem');
    menu.insertBefore(b, before);
    return b;
  };
  addItem('shared-btn', 'Shared media and files', () => openShared());
  addItem('date-btn', 'Jump to date', () => openDate());
  addItem('export-btn', 'Export chat', () => openExport());

  function openDate() {
    const key = active();
    if (!key) return;
    const thread = db().threads[key] || [];
    const d = dialog('Jump to date');
    const day = el('input', 'text-input');
    day.type = 'date';
    const iso = (ts) => new Date(ts - new Date(ts).getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
    day.max = iso(Date.now());
    if (thread[0]) day.min = iso(thread[0].ts);
    day.value = day.max;
    const row = el('label', 'field'); row.append(el('span', '', 'Date'), day);
    const go = () => {
      const [y, m, dd] = day.value.split('-').map(Number);
      const target = messageOnDay(thread, new Date(y, m - 1, dd).getTime());
      d.close();
      if (!target) { toast('No messages in this chat yet.'); return; }
      api.jumpTo(target.id);
    };
    day.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    d.append(row, actions(button('Cancel', 'ghost', () => d.close()), button('Go', 'primary', go)));
    d.showModal();
    day.focus();
  }

  function openExport() {
    const key = active();
    if (!key) return;
    const d = dialog(`Export ${api.chatName(key)}`);
    const fmt = select('Format', [['html', 'Web page (.html)'], ['txt', 'Plain text (.txt)'], ['json', 'Data (.json)']], 'html');
    const media = check('Include photos and files', false, 'Makes the file larger. Voice messages and files are included only in .json.');
    d.append(el('p', 'muted small', 'The export is decrypted: anyone who gets the file can read it. It is saved only on this device.'), fmt.label, media.label,
      actions(button('Cancel', 'ghost', () => d.close()), button('Export', 'primary', () => {
        const format = fmt.input.value;
        const text = exportChat({ name: api.chatName(key), me: db().handle, thread: db().threads[key] || [], format, media: media.input.checked });
        download(exportFileName(api.chatName(key), format), text, format === 'json' ? 'application/json' : format === 'txt' ? 'text/plain;charset=utf-8' : 'text/html;charset=utf-8');
        d.close();
        toast('Chat exported');
      })));
    d.showModal();
  }

  function openShared() {
    const key = active();
    if (!key) return;
    const s = sharedOf(db().threads[key] || []);
    const d = dialog(`Shared in ${api.chatName(key)}`, { cls: 'shared-dialog' });
    const tabs = el('div', 'seg');
    const body = el('div', 'shared-body');
    const kinds = [['media', 'Photos'], ['files', 'Files'], ['voice', 'Voice'], ['links', 'Links']];
    const show = (kind) => {
      for (const b of tabs.children) b.classList.toggle('active', b.dataset.kind === kind);
      body.replaceChildren();
      const list = s[kind];
      if (!list.length) { body.append(el('p', 'muted small', 'Nothing here yet.')); return; }
      if (kind === 'media') {
        const grid = el('div', 'shared-grid');
        for (const m of list) {
          const img = el('img');
          img.alt = 'Photo';
          if (m.media.data) img.src = `data:${m.media.mime};base64,${m.media.data}`;
          img.onclick = () => { d.close(); openViewer(m); };
          grid.append(img);
        }
        body.append(grid);
        return;
      }
      const ul = el('ul', 'fwd-list');
      for (const item of list) {
        const m = item.m || item;
        const li = el('li', 'shared-row');
        const main = el('div', 'contact-main');
        if (kind === 'links') {
          const a = el('a', 'shared-link', item.url);
          a.href = item.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
          main.append(a);
        } else if (kind === 'voice' && m.media.data) {
          const au = el('audio'); au.controls = true; au.preload = 'none'; au.src = api.blobUrl(m);
          main.append(au);
        } else if (m.media.data) {
          const a = el('a', 'shared-link', m.media.name || 'file');
          a.href = api.blobUrl(m); a.download = m.media.name || 'file';
          main.append(a);
        } else main.append(el('span', 'muted', `${m.media?.name || 'file'} · not on this device`));
        main.append(el('div', 'contact-time', `${m.from === db().handle ? 'You' : m.from} · ${new Date(m.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`));
        li.append(main, button('Show in chat', 'ghost', () => { d.close(); api.jumpTo(m.id); }));
        ul.append(li);
      }
      body.append(ul);
    };
    for (const [k, t] of kinds) { const b = button(`${t} · ${s[k].length}`, '', () => show(k)); b.dataset.kind = k; tabs.append(b); }
    d.append(tabs, body, actions(button('Close', 'ghost', () => d.close())));
    show(kinds.find(([k]) => s[k].length)?.[0] || 'media');
    d.showModal();
  }

  // ---------- media viewer: every photo in the chat, zoom, save ----------
  const viewer = $('viewer');
  const vImg = $('viewer-img');
  const vBar = el('div', 'viewer-bar');
  const vCount = el('span', 'viewer-count');
  const vPrev = button('‹', 'viewer-nav prev'); vPrev.setAttribute('aria-label', 'Previous photo');
  const vNext = button('›', 'viewer-nav next'); vNext.setAttribute('aria-label', 'Next photo');
  const vZoom = button('Zoom', 'ghost');
  const vSave = el('a', 'ghost viewer-save', 'Save');
  const vChat = button('Show in chat', 'ghost');
  const vClose = button('Close', 'ghost');
  vBar.append(vCount, vZoom, vSave, vChat, vClose);
  viewer.append(vPrev, vNext, vBar);
  let gallery = [], gi = 0, zoomed = false;
  function drawViewer() {
    const m = gallery[gi];
    if (!m) return;
    vImg.src = `data:${m.media.mime};base64,${m.media.data}`;
    vSave.href = api.blobUrl(m);
    vSave.download = m.media.name || 'photo.jpg';
    vCount.textContent = `${gi + 1} / ${gallery.length} · ${m.from === db().handle ? 'You' : m.from} · ${new Date(m.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    vPrev.disabled = gi === 0; vNext.disabled = gi === gallery.length - 1;
    setZoom(false);
  }
  function setZoom(on) { zoomed = on; viewer.classList.toggle('zoomed', on); vZoom.textContent = on ? 'Fit' : 'Zoom'; }
  function openViewer(m) {
    gallery = sharedOf(db().threads[active()] || []).media.filter((x) => x.media.data).reverse();
    gi = Math.max(0, gallery.findIndex((x) => x.id === m.id));
    if (!gallery.length) return;
    drawViewer();
    viewer.classList.remove('hidden');
    vClose.focus();
  }
  const closeViewer = () => { viewer.classList.add('hidden'); vImg.removeAttribute('src'); setZoom(false); };
  const step = (n) => { const j = gi + n; if (j >= 0 && j < gallery.length) { gi = j; drawViewer(); } };
  vPrev.onclick = (e) => { e.stopPropagation(); step(-1); };
  vNext.onclick = (e) => { e.stopPropagation(); step(1); };
  vZoom.onclick = (e) => { e.stopPropagation(); setZoom(!zoomed); };
  vSave.onclick = (e) => e.stopPropagation();
  vChat.onclick = (e) => { e.stopPropagation(); const m = gallery[gi]; closeViewer(); if (m) api.jumpTo(m.id); };
  vClose.onclick = (e) => { e.stopPropagation(); closeViewer(); };
  vImg.onclick = (e) => { e.stopPropagation(); setZoom(!zoomed); };
  viewer.onclick = (e) => { if (e.target === viewer) closeViewer(); };
  document.addEventListener('keydown', (e) => {
    if (viewer.classList.contains('hidden')) return;
    const act = { ArrowLeft: () => step(-1), ArrowRight: () => step(1), '+': () => setZoom(true), '=': () => setZoom(true), '-': () => setZoom(false) }[e.key];
    if (act) { e.preventDefault(); act(); }
  });

  // ---------- message formatting ----------
  function formatInto(node, text) {
    for (const tk of formatTokens(text)) {
      if (tk.t === 'text') { node.append(document.createTextNode(tk.v)); continue; }
      if (tk.t === 'link') {
        const a = el('a', 'msg-link', tk.v);
        a.href = tk.v; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.addEventListener('click', (e) => e.stopPropagation());
        node.append(a);
        continue;
      }
      if (tk.t === 'hide') {
        const s = el('span', 'spoiler', tk.v);
        s.title = 'Hidden text: click to show';
        s.tabIndex = 0;
        const reveal = (e) => { e.stopPropagation(); s.classList.add('shown'); };
        s.addEventListener('click', reveal);
        s.addEventListener('keydown', (e) => { if (e.key === 'Enter') reveal(e); });
        node.append(s);
        continue;
      }
      node.append(el({ b: 'strong', i: 'em', s: 's', code: 'code', pre: 'pre' }[tk.t], 'fmt-' + tk.t, tk.v));
    }
  }

  // ---------- drag and drop, several files at once ----------
  const drop = el('div', 'drop-zone hidden');
  drop.append(el('div', '', 'Drop to send · end-to-end encrypted'));
  $('thread').append(drop);
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  $('thread').addEventListener('dragenter', (e) => { if (!active() || !hasFiles(e)) return; dragDepth++; drop.classList.remove('hidden'); });
  $('thread').addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.add('hidden'); } });
  $('thread').addEventListener('dragover', (e) => { if (active() && hasFiles(e)) e.preventDefault(); });
  $('thread').addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; drop.classList.add('hidden');
    sendFiles([...(e.dataTransfer?.files || [])]);
  });
  async function sendFiles(files) {
    for (const f of files.slice(0, 10)) await api.sendAttachment(f);
    if (files.length > 10) toast('Up to 10 files at a time.');
  }

  // ---------- keyboard shortcuts ----------
  function openShortcuts() {
    const d = dialog('Keyboard shortcuts', { cls: 'keys-dialog' });
    const t = el('table', 'split sec keys');
    const tb = el('tbody');
    for (const s of SHORTCUTS) {
      const tr = el('tr');
      tr.append(el('th', '', shortcutLabel(s.keys, MAC)), el('td', '', s.label));
      tb.append(tr);
    }
    if (desktop) { const tr = el('tr'); tr.append(el('th', '', MAC ? '⌘⌥F' : 'Ctrl+Alt+F'), el('td', '', 'Show or hide FabriC++ from anywhere (desktop app)')); tb.append(tr); }
    t.append(tb);
    d.append(t, el('p', 'muted small', 'Hold or right-click the send button to send without sound or schedule a message.'), actions(button('Close', 'ghost', () => d.close())));
    d.showModal();
  }
  function stepChat(n) {
    const keys = [...document.querySelectorAll('#contacts li[data-key]')].map((li) => li.dataset.key);
    if (!keys.length) return;
    const i = keys.indexOf(active());
    const j = i < 0 ? (n > 0 ? 0 : keys.length - 1) : Math.max(0, Math.min(keys.length - 1, i + n));
    if (keys[j] !== active()) api.openThread(keys[j]);
  }
  function editLast() {
    const key = active();
    const m = [...(db().threads[key] || [])].reverse().find((x) => x.from === db().handle && !x.deleted && !x.media && x.text);
    if (!m) return false;
    api.startEdit(m);
    return true;
  }
  async function lockNow() {
    if (!(await api.passphraseSet())) { toast('Set a passphrase first: Settings › Privacy and security.'); return; }
    api.lock();
  }
  document.addEventListener('keydown', (e) => {
    if ($('app').classList.contains('hidden') || e.defaultPrevented) return;
    const t = $('text');
    const sc = shortcutFor(e, { mac: MAC, composerEmpty: document.activeElement === t && !t.value });
    if (!sc) return;
    if (document.querySelector('dialog[open]') && sc.action !== 'help') return;
    const run = {
      search: () => { api.switchTab('chats'); const i = $('add-handle'); i.focus(); i.select(); },
      find: () => (active() ? api.openThreadSearch() : run.search()),
      date: () => active() && openDate(),
      prev: () => stepChat(-1),
      next: () => stepChat(1),
      folder: () => { const f = folders()[sc.n - 1]; if (f) setFolder(f.id); },
      saved: () => api.openThread(SAVED),
      editLast: () => (active() ? editLast() : false),
      mute: () => muteChat(active()),
      export: () => active() && openExport(),
      settings: () => api.switchTab('settings'),
      lock: lockNow,
      help: openShortcuts,
    }[sc.action];
    if (run && run() !== false) e.preventDefault();
  });

  // ---------- Saved messages: a way in from the sidebar ----------
  const savedBtn = button('', 'icon-btn');
  savedBtn.id = 'open-saved';
  savedBtn.title = `Saved messages (${shortcutLabel('mod+0', MAC)})`;
  savedBtn.setAttribute('aria-label', 'Saved messages');
  savedBtn.append(api.svgIcon('M6 3h12v18l-6-4-6 4z'));
  savedBtn.onclick = () => api.openThread(SAVED);
  document.querySelector('.side-top .icon-row')?.prepend(savedBtn);

  // ---------- notifications: preview, sound, do not disturb ----------
  let audio = null;
  function chime() {
    try {
      audio ??= new AudioContext();
      const t0 = audio.currentTime;
      for (const [f, at] of [[988, 0], [740, 0.11]]) {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.16);
        o.connect(g).connect(audio.destination);
        o.start(t0 + at); o.stop(t0 + at + 0.18);
      }
    } catch { /* no audio here */ }
  }
  /** Title and body for a notification, or null to stay quiet. */
  function notification(key, entry, body) {
    if (entry.silent || prefs()[key]?.muted) return null;
    if ((uprefs().dndUntil || 0) > Date.now()) return null;
    const mode = uprefs().notifyPreview || 'full';
    if (uprefs().notifySound !== false) chime();
    if (mode === 'none') return { title: 'FabriC++', body: 'New message' };
    if (mode === 'name') return { title: api.chatName(key), body: 'New message' };
    return { title: api.chatName(key), body: plainText(body) };
  }

  // ---------- auto-lock ----------
  let lastActive = Date.now();
  let hasPass = false;
  const refreshPass = () => api.passphraseSet().then((v) => { hasPass = v; }).catch(() => {});
  refreshPass();
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true, capture: true });
  setInterval(() => {
    if (!db().handle || !hasPass || $('app').classList.contains('hidden')) return;
    if (lockDue(lastActive, uprefs().autoLock || 0)) api.lock();
  }, 15e3);

  // ---------- several accounts on this device ----------
  const ACCOUNTS_KEY = 'fabric-accounts';
  function onSignedIn() {
    store.set(ACCOUNTS_KEY, noteAccount(store.get(ACCOUNTS_KEY, []), api.profile, db().handle));
    refreshPass();
  }
  const profileUrl = (p) => (p === 'default' ? '/' : `/?profile=${encodeURIComponent(p)}`);

  // ---------- picture-in-picture for calls ----------
  const pip = button('Pop out', 'ghost hidden');
  pip.id = 'call-pip';
  pip.title = 'Keep the video on top while you use other apps';
  pip.onclick = async () => {
    try {
      if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
      const v = [...document.querySelectorAll('#call-grid video')].find((x) => x.srcObject && x.videoWidth) || ($('local-video').videoWidth ? $('local-video') : null);
      if (!v) { toast('No video to pop out yet.'); return; }
      await v.requestPictureInPicture();
    } catch { toast('Picture-in-picture is not available here.'); }
  };
  $('call-end').before(pip);
  new MutationObserver(() => {
    const inCall = !$('call').classList.contains('hidden') && !$('call-end').classList.contains('hidden');
    pip.classList.toggle('hidden', !inCall || !document.pictureInPictureEnabled);
    if (!inCall && document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  }).observe($('call'), { attributes: true, subtree: true, attributeFilter: ['class'] });

  // ---------- settings: appearance, notifications, accounts, auto-lock, desktop app ----------
  const box = el('div', 'desk-settings');
  box.id = 'desk-settings';
  document.querySelector('#view-settings .settings-list')?.before(box);
  async function renderSettings() {
    box.replaceChildren();
    const a = { ...APPEAR_DEFAULT, ...store.get(APPEAR_KEY, APPEAR_DEFAULT) };
    const setA = (k, v) => { a[k] = v; store.set(APPEAR_KEY, a); applyAppearance(a); };

    const look = el('div', 'chat-prefs');
    look.append(el('h3', 'eyebrow', 'Appearance'));
    const size = select('Text size', [['s', 'Small'], ['m', 'Default'], ['l', 'Large'], ['xl', 'Larger']], a.size);
    size.input.id = 'pref-text-size';
    size.input.onchange = () => setA('size', size.input.value);
    const bg = select('Chat background', [['plain', 'Plain'], ['grid', 'Hairline grid'], ['dots', 'Dot grid'], ['rule', 'Diagonal rule']], a.bg);
    bg.input.id = 'pref-chat-bg';
    bg.input.onchange = () => setA('bg', bg.input.value);
    const compact = check('Compact chat list', a.compact, 'Fit more chats on screen.');
    compact.input.onchange = () => setA('compact', compact.input.checked);
    look.append(size.label, bg.label, compact.label);

    const note = el('div', 'chat-prefs');
    note.append(el('h3', 'eyebrow', 'Notifications'));
    const sound = check('Sound', uprefs().notifySound !== false, 'A short chime with each notification.');
    sound.input.onchange = () => { uprefs().notifySound = sound.input.checked; api.persist(); if (sound.input.checked) chime(); };
    const prev = select('Show in notifications', [['full', 'Name and message'], ['name', 'Name only'], ['none', 'Nothing (just “New message”)']], uprefs().notifyPreview || 'full');
    prev.input.id = 'pref-notify-preview';
    prev.input.onchange = () => { uprefs().notifyPreview = prev.input.value; api.persist(); };
    note.append(sound.label, prev.label, el('p', 'muted small', 'Mute single chats from their menu, for an hour up to always. Senders can also send a message without sound.'));

    const lock = el('div', 'chat-prefs');
    lock.append(el('h3', 'eyebrow', 'Auto-lock'));
    hasPass = await api.passphraseSet();
    const al = select('Lock after', AUTOLOCK_CHOICES.map((m) => [m, m ? `${m} minute${m > 1 ? 's' : ''} away` : 'Never']), uprefs().autoLock || 0);
    al.input.id = 'pref-autolock';
    al.input.disabled = !hasPass;
    al.input.onchange = () => { uprefs().autoLock = Number(al.input.value); api.persist(); };
    lock.append(al.label, el('p', 'muted small', hasPass
      ? `Locking drops every key from memory; your passphrase opens it again. ${shortcutLabel('mod+L', MAC)} locks now.`
      : 'Needs a passphrase: set one in Privacy and security.'));

    const acc = el('div', 'chat-prefs');
    acc.append(el('h3', 'eyebrow', 'Accounts on this device'));
    const list = store.get(ACCOUNTS_KEY, []);
    const ul = el('ul', 'fwd-list accounts');
    for (const x of list) {
      const li = el('li', 'folder-row');
      li.append(el('span', 'contact-name', x.handle || '(not set up)'), el('span', 'muted small', x.profile === 'default' ? 'main profile' : `profile ${x.profile}`));
      if (x.profile === api.profile) li.append(el('span', 'muted small', 'this account'));
      else li.append(button('Switch', 'ghost', () => { location.href = profileUrl(x.profile); }));
      ul.append(li);
    }
    const add = button('Add another account', 'ghost', () => {
      const p = 'a' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 6);
      location.href = profileUrl(p);
    });
    add.id = 'add-account';
    add.disabled = list.length >= MAX_ACCOUNTS;
    acc.append(ul, add, el('p', 'muted small', 'Each account has its own keys and its own encrypted storage on this device.'));

    box.append(look, note, lock, acc);
    if (desktop) box.append(await desktopCard());
  }

  async function desktopCard() {
    const card = el('div', 'chat-prefs');
    card.id = 'desktop-card';
    card.append(el('h3', 'eyebrow', 'Desktop app'));
    let s = {};
    try { s = await desktop.getSettings(); } catch { /* older shell */ }
    const set = async (k, v) => { try { s = await desktop.setSetting(k, v); } catch { toast('Could not change that setting.'); } };
    const rows = [
      ['openAtLogin', 'Start FabriC++ when you sign in to this computer'],
      ['startMinimized', 'Start in the tray', 'When it starts with your computer, stay out of the way.'],
      ['closeToTray', 'Closing the window keeps FabriC++ running', 'Messages and calls keep arriving. Quit from the tray.'],
      ['globalShortcut', `${MAC ? '⌘⌥F' : 'Ctrl+Alt+F'} shows or hides FabriC++ from anywhere`],
      ['flashFrame', 'Flash the taskbar button for new messages'],
      ['spellcheck', 'Check spelling as you type'],
    ];
    for (const [k, label, hint] of rows) {
      const c = check(label, s[k], hint);
      c.input.dataset.setting = k;
      c.input.onchange = () => set(k, c.input.checked);
      card.append(c.label);
    }
    let langs = [];
    try { langs = await desktop.spellLanguages(); } catch { /* */ }
    if (langs.length) {
      const pick = el('div', 'lang-pick');
      pick.id = 'spell-langs';
      const chosen = new Set(s.spellLanguages || []);
      for (const code of langs) {
        const c = check(code, chosen.has(code));
        c.input.onchange = () => {
          if (c.input.checked) chosen.add(code); else chosen.delete(code);
          if (!chosen.size) { chosen.add(code); c.input.checked = true; toast('Keep at least one language.'); return; }
          set('spellLanguages', [...chosen].slice(0, 5));
        };
        pick.append(c.label);
      }
      card.append(el('div', 'eyebrow', 'Spelling languages'), pick);
    }
    card.append(el('p', 'muted small', `FabriC++ ${desktop.version || ''} for ${desktop.platform === 'darwin' ? 'macOS' : desktop.platform === 'win32' ? 'Windows' : desktop.platform}. It connects only to its own relay and uses this computer's proxy settings.`));
    return card;
  }

  // the desktop shell's tray menu
  desktop?.onCommand?.((c) => {
    if (c === 'lock') lockNow();
    else if (c === 'dnd-1h') { uprefs().dndUntil = Date.now() + 3600e3; api.persist(); toast('Notifications off for an hour'); }
    else if (c === 'dnd-off') { delete uprefs().dndUntil; api.persist(); toast('Notifications on'); }
    else if (c === 'saved') api.openThread(SAVED);
  });

  return {
    renderFolders, matches, draftOf, saveDraft, restoreDraft, clearDraft, formatInto, openViewer, notification,
    renderThreadExtras, renderSettings, onSignedIn, sendFiles, muteLabel: (k) => muteLabel(prefs()[k]), sweepMutes,
  };
}
