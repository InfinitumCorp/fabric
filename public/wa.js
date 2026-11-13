// Everyday messenger features for the web client (and so the desktop and Android apps): an attach
// sheet with location, contact cards and view-once photos; @mentions in groups; starred messages;
// message info; blocking; contact info; and an "about" line on your profile. Pure logic lives in
// /shared/wa.js and /shared/profile.js.
import {
  locFallback, mapsUrl, cardFallback, spendOnce, mentionsIn, mentionQuery, insertMention, isBlocked, messageInfo,
} from '/shared/wa.js';
import { cleanAbout, MAX_ABOUT } from '/shared/profile.js';

export function installWa(api) {
  const { $, el, toast } = api;
  const db = () => api.db();
  const active = () => api.active();
  const me = () => db()?.handle;
  const short = (h) => h.replace(/^@/, '').replace(/\.veil$/, '');

  // ---------- small UI kit (same house style as desk.js) ----------
  function dialog(title, cls = '') {
    const d = el('dialog', 'fwd-dialog desk-dialog ' + cls);
    d.setAttribute('aria-label', title);
    d.append(el('h3', '', title));
    d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    document.body.append(d);
    return d;
  }
  function button(text, cls, onclick) { const b = el('button', cls, text); b.type = 'button'; if (onclick) b.onclick = onclick; return b; }
  function actions(...btns) { const r = el('div', 'dialog-actions'); r.append(...btns); return r; }
  function menuItem(id, text, onclick) { const b = button(text, '', onclick); b.id = id; b.setAttribute('role', 'menuitem'); return b; }
  const when = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  // ---------- attach sheet ----------
  const onceInput = el('input');
  onceInput.type = 'file'; onceInput.accept = 'image/*'; onceInput.hidden = true;
  document.body.append(onceInput);
  onceInput.onchange = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) api.sendAttachment(f, { once: true }); };

  function openAttach() {
    const to = active();
    if (!to) return;
    if (to === api.SAVED) { $('attach-input').click(); return; }
    const d = dialog('Send', 'attach-sheet');
    const grid = el('div', 'attach-grid');
    const item = (label, hint, fn) => {
      const b = button('', 'attach-item', () => { d.close(); fn(); });
      b.append(el('span', 'attach-label', label), el('small', 'muted', hint));
      grid.append(b);
    };
    item('Photo or file', 'Up to 140 KB, encrypted', () => $('attach-input').click());
    item('View-once photo', 'Opens one time, then it’s gone', () => onceInput.click());
    item('Location', 'Your current spot, once', () => shareLocation(to));
    item('Contact', 'Share someone’s handle', () => shareContact(to));
    if ($('poll-btn')) item('Poll', 'Ask the chat to vote', () => $('poll-btn').click());
    if (api.openEvent) item('Event', 'Plan something, collect answers', () => api.openEvent(to));
    if (api.openStickers) item('Sticker', 'From your sticker tray', () => api.openStickers(to));
    d.append(grid, actions(button('Cancel', 'ghost', () => d.close())));
    d.showModal();
  }
  $('attach').onclick = openAttach;

  function shareLocation(to) {
    if (!navigator.geolocation) { toast('Location isn’t available on this device.'); return; }
    toast('Finding your location…');
    navigator.geolocation.getCurrentPosition((pos) => {
      const loc = { lat: Math.round(pos.coords.latitude * 1e6) / 1e6, lon: Math.round(pos.coords.longitude * 1e6) / 1e6, acc: Math.round(pos.coords.accuracy || 0) || undefined };
      const d = dialog('Send your location?');
      const label = el('input', 'text-input'); label.maxLength = 80; label.placeholder = 'Name this place (optional)';
      d.append(el('p', '', `${loc.lat}, ${loc.lon}${loc.acc ? ` · within ${loc.acc} m` : ''}`),
        label,
        el('p', 'muted small', `It goes end-to-end encrypted to ${api.chatName(to)}, one time. FabriC++ doesn't track you afterwards and loads no map: the link opens OpenStreetMap only when tapped.`),
        actions(button('Cancel', 'ghost', () => d.close()), button('Send location', 'primary', () => {
          const l = { ...loc, ...(label.value.trim() ? { label: label.value.trim() } : {}) };
          if (!l.acc) delete l.acc;
          d.close();
          api.sendText(locFallback(l), null, { loc: l }, to);
        })));
      d.showModal();
    }, (err) => toast(err.code === 2 || err.code === 3 ? 'Couldn’t get your location. Is location on?' : 'Location isn’t allowed for FabriC++. You can allow it in this device’s settings.'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  function shareContact(to) {
    const people = api.chatKeys().filter((k) => !api.isGroupKey(k) && k !== api.SAVED && k !== to && /^@/.test(k));
    const d = dialog('Share a contact');
    const ul = el('ul', 'fwd-list');
    const mine = button('', 'fwd-to', () => { d.close(); send(me()); });
    mine.append(api.avatarEl(me()), el('span', 'contact-name', `${me()} (you)`));
    const first = el('li'); first.append(mine); ul.append(first);
    for (const h of people.sort()) {
      const b = button('', 'fwd-to', () => { d.close(); send(h); });
      b.append(api.avatarEl(h), el('span', 'contact-name', h));
      const li = el('li'); li.append(b); ul.append(li);
    }
    function send(h) { const card = { handle: h }; api.sendText(cardFallback(card), null, { card }, to); }
    d.append(ul, actions(button('Cancel', 'ghost', () => d.close())));
    d.showModal();
  }

  // ---------- rendering message bodies ----------
  /** Location and contact cards replace the text. Returns true when it drew the body. */
  function renderBody(li, m) {
    if (m.loc) {
      const box = el('div', 'wa-card wa-loc');
      box.append(el('div', 'eyebrow', 'Location'));
      if (m.loc.label) box.append(el('div', 'wa-title', m.loc.label));
      box.append(el('div', 'wa-sub', `${m.loc.lat}, ${m.loc.lon}${m.loc.acc ? ` · within ${m.loc.acc} m` : ''}`));
      const a = el('a', 'ghost small wa-open', 'Open map ↗');
      a.href = mapsUrl(m.loc); a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.onclick = (e) => e.stopPropagation();
      box.append(a);
      li.append(box);
      return true;
    }
    if (m.card) {
      const box = el('div', 'wa-card wa-contact');
      const row = el('div', 'wa-row');
      row.append(api.avatarEl(m.card.handle), el('div', 'wa-title', m.card.name || m.card.handle));
      box.append(el('div', 'eyebrow', 'Contact'), row);
      if (m.card.name) box.append(el('div', 'wa-sub', m.card.handle));
      if (m.card.handle !== me()) {
        box.append(button('Message', 'ghost small', async (e) => {
          e.stopPropagation();
          if (!db().contacts[m.card.handle]) { try { await api.addContact(m.card.handle); } catch (err) { toast(err.message || 'Couldn’t add that contact.'); return; } }
          api.openThread(m.card.handle);
        }));
      }
      li.append(box);
      return true;
    }
    return false;
  }

  /** A view-once photo: a button that opens it one time. */
  function onceEl(m) {
    const mine = m.from === me();
    const b = button('', 'wa-once' + (m.media?.data && !mine ? '' : ' spent'));
    b.append(el('span', 'wa-once-mark', '1'), el('span', '', mine ? 'View-once photo · sent' : m.media?.data ? 'View-once photo · tap to open' : `Opened${m.opened ? ' ' + when(m.opened) : ''}`));
    if (!mine && m.media?.data) b.onclick = (e) => { e.stopPropagation(); openOnce(m); };
    else b.disabled = true;
    return b;
  }
  function openOnce(m) {
    const src = `data:${m.media.mime};base64,${m.media.data}`; // mime checked against an image allowlist
    // spent the moment it opens: a reload or crash doesn't give a second look
    spendOnce(m);
    api.persist();
    const v = el('div', 'wa-once-view');
    v.setAttribute('role', 'dialog'); v.setAttribute('aria-label', 'View-once photo');
    const img = el('img'); img.alt = 'View-once photo'; img.src = src; img.draggable = false;
    img.oncontextmenu = (e) => e.preventDefault();
    const close = () => { v.remove(); document.removeEventListener('keydown', esc); api.renderMessages(); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    v.append(el('div', 'wa-once-note', 'View once · it’s gone when you close it'), img, button('Close', 'ghost', close));
    v.onclick = (e) => { if (e.target === v) close(); };
    document.addEventListener('keydown', esc);
    document.body.append(v);
  }

  // ---------- @mentions ----------
  /** Wrap @handles in a message's text so mentions stand out (mine more so). */
  function markMentions(node) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) if (/@[a-z0-9_]{2,24}\.veil\b/.test(walker.currentNode.nodeValue)) hits.push(walker.currentNode);
    for (const t of hits) {
      const frag = document.createDocumentFragment();
      let last = 0;
      const s = t.nodeValue;
      for (const mt of s.matchAll(/@[a-z0-9_]{2,24}\.veil\b/g)) {
        frag.append(document.createTextNode(s.slice(last, mt.index)));
        frag.append(el('span', 'mention' + (mt[0] === me() ? ' me' : ''), mt[0]));
        last = mt.index + mt[0].length;
      }
      frag.append(document.createTextNode(s.slice(last)));
      t.replaceWith(frag);
    }
  }
  const picker = el('ul', 'mention-pick hidden');
  picker.setAttribute('role', 'listbox');
  $('composer').before(picker);
  let pickIdx = 0;
  function membersHere() {
    const g = api.groupFor(active());
    return g ? g.members.filter((h) => h !== me()) : [];
  }
  function updatePicker() {
    const t = $('text');
    const q = api.isGroupKey(active()) ? mentionQuery(t.value, t.selectionStart) : null;
    const list = q === null ? [] : membersHere().filter((h) => short(h).startsWith(q.replace(/\.veil$/, '')) || h.startsWith('@' + q)).slice(0, 6);
    picker.replaceChildren();
    picker.classList.toggle('hidden', !list.length);
    pickIdx = Math.min(pickIdx, Math.max(0, list.length - 1));
    list.forEach((h, i) => {
      const li = el('li', i === pickIdx ? 'on' : '');
      li.setAttribute('role', 'option');
      li.dataset.h = h; // the text on screen may be shown in another form (+name)
      li.append(api.avatarEl(h), el('span', '', h));
      li.onpointerdown = (e) => { e.preventDefault(); choose(h); };
      picker.append(li);
    });
  }
  function choose(h) {
    const t = $('text');
    const r = insertMention(t.value, t.selectionStart, h);
    t.value = r.text; t.setSelectionRange(r.caret, r.caret);
    picker.classList.add('hidden');
    api.growText(); t.focus();
  }
  $('text').addEventListener('input', () => { pickIdx = 0; updatePicker(); });
  $('text').addEventListener('click', updatePicker);
  $('text').addEventListener('blur', () => setTimeout(() => picker.classList.add('hidden'), 150));
  $('text').addEventListener('keydown', (e) => {
    if (picker.classList.contains('hidden')) return;
    const n = picker.children.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pickIdx = (pickIdx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; updatePicker(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); choose(picker.children[pickIdx].dataset.h); }
    else if (e.key === 'Escape') { picker.classList.add('hidden'); }
  }, true);
  const mentionsFor = (text) => mentionsIn(text, api.groupFor(active())?.members || []);

  // ---------- message menu: star, info ----------
  const starItem = menuItem('msg-star', 'Star', () => {
    const m = api.menuMsg(); api.closeMsgMenu();
    if (!m) return;
    if (m.starred) delete m.starred; else m.starred = Date.now();
    api.persist(); api.renderMessages();
    toast(m.starred ? 'Starred' : 'Unstarred');
  });
  const infoItem = menuItem('msg-info', 'Info', () => { const m = api.menuMsg(); api.closeMsgMenu(); if (m) openInfo(m); });
  $('msg-copy').before(starItem);
  $('msg-delete-me').before(infoItem);
  function onMsgMenu(m) {
    starItem.textContent = m.starred ? 'Unstar' : 'Star';
    starItem.classList.toggle('hidden', Boolean(m.deleted));
    infoItem.classList.toggle('hidden', m.from !== me() || Boolean(m.deleted) || active() === api.SAVED);
    if (m.once) { $('msg-forward').classList.add('hidden'); $('msg-copy').classList.toggle('hidden', !m.text); starItem.classList.add('hidden'); }
  }
  function openInfo(m) {
    const g = api.groupFor(active());
    const rows = messageInfo(m, g?.members || [], me());
    const d = dialog('Message info');
    d.append(el('p', 'muted small', `Sent ${when(m.ts)}${m.edited ? ` · edited ${when(m.edited)}` : ''}`));
    const ul = el('ul', 'fwd-list wa-info');
    for (const r of rows) {
      const li = el('li', 'wa-info-row');
      const who = r.who || active();
      li.append(api.avatarEl(who), el('span', 'contact-name', who),
        el('span', 'muted small', r.read ? `Read ${when(r.read)}` : /^(delivered|queued)/.test(m.status || '') || m.readBy ? 'Delivered' : m.status || 'Sent'));
      ul.append(li);
    }
    d.append(ul);
    if (api.userPrefs().receipts === false) d.append(el('p', 'muted small', 'Read receipts are off in your settings, so you don’t see who read it.'));
    d.append(actions(button('Close', 'ghost', () => d.close())));
    d.showModal();
  }

  function openStarred(only = null) {
    const d = dialog(only ? 'Starred in this chat' : 'Starred messages');
    const ul = el('ul', 'fwd-list');
    const all = [];
    for (const [k, t] of Object.entries(db().threads || {})) {
      if (only && k !== only) continue;
      for (const m of t) if (m.starred && !m.deleted) all.push([k, m]);
    }
    all.sort((a, b) => b[1].starred - a[1].starred);
    if (!all.length) ul.append(el('li', 'contacts-empty', 'Nothing starred yet. Hold or right-click a message and choose Star.'));
    for (const [k, m] of all) {
      const b = button('', 'fwd-to wa-starred', () => { d.close(); api.openThread(k).then?.(() => setTimeout(() => api.jumpTo(m.id), 50)); });
      const main = el('div', 'contact-main');
      main.append(el('div', 'contact-time', `${api.chatName(k)} · ${m.from === me() ? 'You' : m.from} · ${when(m.ts)}`),
        el('div', 'preview', m.loc ? '📍 Location' : m.card ? `👤 ${m.card.handle}` : m.poll ? `📊 ${m.poll.q}` : m.text || (m.media ? m.media.name || 'Photo' : '')));
      b.append(main);
      const li = el('li'); li.append(b); ul.append(li);
    }
    d.append(ul, actions(button('Close', 'ghost', () => d.close())));
    d.showModal();
  }

  // ---------- blocking ----------
  async function setBlocked(h, on) {
    db().blocked ??= {};
    if (on) db().blocked[h] = Date.now(); else delete db().blocked[h];
    api.systemLine(h, on ? 'You blocked this contact' : 'You unblocked this contact');
    await api.persist();
    api.renderContacts();
    if (active() === h) { api.renderMessages(); renderBlockBar(); }
    toast(on ? `${h} is blocked` : `${h} is unblocked`);
  }
  function askBlock(h) {
    if (!h || api.isGroupKey(h) || h === api.SAVED) return;
    if (isBlocked(db(), h)) { setBlocked(h, false); return; }
    const d = dialog(`Block ${h}?`);
    d.append(el('p', '', 'They won’t be able to message or call you here. They aren’t told, and they stop getting your photo and about line. Groups you share are unchanged.'),
      actions(button('Cancel', 'ghost', () => d.close()), button('Block', 'primary danger', () => { d.close(); setBlocked(h, true); })));
    d.showModal();
  }
  const blockBar = button('', 'sched-bar wa-block-bar hidden', () => askBlock(active()));
  blockBar.id = 'block-bar';
  $('composer').before(blockBar);
  function renderBlockBar() {
    const on = isBlocked(db(), active());
    blockBar.classList.toggle('hidden', !on);
    blockBar.textContent = on ? 'You blocked this contact · tap to unblock' : '';
    $('composer').classList.toggle('blocked', on);
  }
  const chatBlock = menuItem('chat-block', 'Block', () => { const k = api.menuChat(); api.closeChatMenu(); askBlock(k); });
  $('chat-delete').before(chatBlock);
  function onChatMenu(key) {
    const one = key && !api.isGroupKey(key) && key !== api.SAVED;
    chatBlock.classList.toggle('hidden', !one);
    chatBlock.textContent = isBlocked(db(), key) ? 'Unblock' : 'Block';
  }

  // ---------- thread menu: contact info, starred, block ----------
  const tmenu = $('thread-menu');
  const tItem = (id, text, fn) => { const b = menuItem(id, text, () => { tmenu.classList.add('hidden'); fn(); }); tmenu.insertBefore(b, $('mute-chat')); return b; };
  const infoBtn = tItem('contact-info-btn', 'Contact info', () => openContactInfo(active()));
  tItem('starred-btn', 'Starred messages', () => openStarred(active()));
  const tBlock = tItem('block-btn', 'Block', () => askBlock(active()));
  function renderThreadExtras() {
    const k = active();
    const one = k && !api.isGroupKey(k) && k !== api.SAVED;
    infoBtn.classList.toggle('hidden', !one);
    tBlock.classList.toggle('hidden', !one);
    tBlock.textContent = isBlocked(db(), k) ? 'Unblock' : 'Block';
    renderBlockBar();
  }

  function openContactInfo(h) {
    const c = db().contacts[h];
    const d = dialog('Contact info', 'wa-contact-info');
    const top = el('div', 'wa-ci-top');
    top.append(api.avatarEl(h, 'avatar huge'), el('div', 'peer', h));
    if (c?.avatar?.about) top.append(el('div', 'wa-about', c.avatar.about));
    const media = (db().threads[h] || []).filter((m) => m.media && !m.deleted && !m.once).length;
    const starred = (db().threads[h] || []).filter((m) => m.starred && !m.deleted).length;
    d.append(top,
      el('p', 'muted small', `${media} photo${media === 1 ? '' : 's'} and files · ${starred} starred`),
      actions(
        button('Starred', 'ghost', () => { d.close(); openStarred(h); }),
        button(isBlocked(db(), h) ? 'Unblock' : 'Block', 'ghost danger', () => { d.close(); askBlock(h); }),
        button('Close', 'ghost', () => d.close())));
    d.showModal();
  }

  // ---------- settings: about line, starred, blocked list ----------
  const aboutRow = el('form', 'wa-about-row');
  const aboutIn = el('input', 'text-input');
  aboutIn.maxLength = MAX_ABOUT; aboutIn.placeholder = 'About (e.g. Available)'; aboutIn.setAttribute('aria-label', 'About');
  aboutIn.enterKeyHint = 'done';
  const aboutSave = button('Save', 'ghost small');
  aboutSave.type = 'submit';
  aboutRow.append(aboutIn, aboutSave);
  aboutRow.onsubmit = async (e) => {
    e.preventDefault();
    const v = cleanAbout(aboutIn.value);
    if (v === (db().profile?.about || '')) { aboutIn.blur(); return; }
    await api.setMyAbout(v);
    aboutIn.blur();
  };
  $('photo-note')?.before(aboutRow);
  if (!$('photo-note')) document.querySelector('.photo-note')?.before(aboutRow);
  const settingsBox = el('div', 'chat-prefs wa-settings');
  settingsBox.append(el('h3', 'eyebrow', 'Privacy'));
  const starredBtn = button('Starred messages', 'ghost', () => openStarred());
  const blockedBtn = button('Blocked contacts', 'ghost', () => openBlocked());
  const row = el('div', 'row'); row.append(starredBtn, blockedBtn);
  settingsBox.append(row);
  $('chat-prefs').after(settingsBox);
  function renderSettings() {
    if (document.activeElement !== aboutIn) aboutIn.value = db()?.profile?.about || '';
    const n = Object.keys(db()?.blocked || {}).length;
    blockedBtn.textContent = n ? `Blocked contacts (${n})` : 'Blocked contacts';
  }
  function openBlocked() {
    const d = dialog('Blocked contacts');
    const ul = el('ul', 'fwd-list');
    const draw = () => {
      ul.replaceChildren();
      const list = Object.keys(db().blocked || {}).sort();
      if (!list.length) ul.append(el('li', 'contacts-empty', 'Nobody is blocked.'));
      for (const h of list) {
        const li = el('li', 'sched-row');
        li.append(api.avatarEl(h), el('span', 'contact-name', h), button('Unblock', 'ghost', async () => { await setBlocked(h, false); draw(); renderSettings(); }));
        ul.append(li);
      }
    };
    draw();
    d.append(ul, actions(button('Close', 'ghost', () => d.close())));
    d.showModal();
  }

  return { renderBody, onceEl, markMentions, onMsgMenu, onChatMenu, renderThreadExtras, renderSettings, mentionsFor, openStarred };
}
