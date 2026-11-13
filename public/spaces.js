// Large groups, channels, FabriC++ Plus and sponsored posts in the client.
// Builds its own screens and dialogs; app.js only forwards relay messages and key payloads here.
//
// Private spaces: posts are AES-GCM encrypted on this device with the space key. The key comes in
// the invite link's #fragment (never sent to the relay) or, after a key change, from an admin over
// the one-to-one end-to-end encrypted session. Public channels are plaintext by design.

import { TOPICS, REACTIONS, can, channelHandle, showHandle } from '/shared/spaces.js';
import { TIERS, compareRows } from '/shared/tiers.js';
import { cacheGet, cachePut } from '/shared/translate.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
const newId = () => b64url(b64(crypto.getRandomValues(new Uint8Array(12))));
const fmtTime = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const MB = 1024 * 1024;

async function newKey() { return b64(crypto.getRandomValues(new Uint8Array(32))); }
async function aesKey(raw) { return subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']); }
const aad = (sid, e) => enc.encode(`fabric-space|${sid}|${e}`);
async function sealPost(raw, sid, e, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(sid, e) }, await aesKey(raw), enc.encode(JSON.stringify(obj)));
  return { e, iv: b64(iv), ct: b64(ct) };
}
async function openPost(raw, sid, body) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(body.iv), additionalData: aad(sid, body.e) }, await aesKey(raw), unb64(body.ct));
  return JSON.parse(dec.decode(pt));
}

const SVG = {
  channel: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l6 4V6L7 10zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/></svg>',
  group: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 010 6M18 14c2 .6 3 2.4 3 5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
};

export function mountSpaces({ request, wsSend, toast, switchTab, me, vault, sendKey, translation: tl = null }) {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, text, onclick, title) => { const b = el('button', cls, text); b.type = 'button'; if (onclick) b.onclick = onclick; if (title) { b.title = title; b.setAttribute('aria-label', title); } return b; };
  const icon = (svg, cls = '') => { const s = el('span', `sp-ico ${cls}`); s.innerHTML = svg; return s; }; // fixed markup from SVG above

  let spaces = [];          // my spaces (summaries from the relay)
  let openSid = null;       // the space on screen
  let posts = [];           // posts of the open space
  let plan = null;          // plus_status from the relay
  let chatAd = null; let chatAdAt = 0; let chatAdHidden = false;
  const keysOf = (sid) => ((vault.get().spaceKeys ??= {})[sid] ??= {});
  const keyFor = (sid, e) => keysOf(sid)[e];
  const saveKey = (sid, e, k) => { keysOf(sid)[e] = k; vault.save(); };
  const cur = () => spaces.find((s) => s.id === openSid) || null;

  // ---------- DOM ----------
  const main = document.querySelector('main.main');
  const view = el('section', 'view hidden sp-view'); view.id = 'view-spaces';
  view.innerHTML = `
    <div class="sp-cols">
      <div class="sp-side">
        <header class="view-head"><button type="button" class="icon-btn back" data-back aria-label="Back">${SVG.back}</button><h2>Channels and groups</h2></header>
        <div class="sp-actions">
          <button type="button" class="ghost" id="sp-new-channel">New channel</button>
          <button type="button" class="ghost" id="sp-new-group">New large group</button>
          <button type="button" class="ghost" id="sp-join-btn">Join</button>
        </div>
        <ul id="sp-list" class="sp-list"></ul>
      </div>
      <div class="sp-feed hidden" id="sp-feed">
        <header class="thread-head sp-head">
          <button type="button" class="icon-btn back" id="sp-close" aria-label="Back to channels and groups">${SVG.back}</button>
          <div class="peer-box"><div class="peer" id="sp-title"></div><div class="peer-sub muted small" id="sp-sub"></div></div>
          <button type="button" class="ghost small sp-tr-btn hidden" id="sp-tr-btn" aria-pressed="false">Translate</button>
          <button type="button" class="icon-btn" id="sp-info-btn" title="Info" aria-label="Info">${SVG.info}</button>
        </header>
        <div class="sp-privacy" id="sp-privacy"></div>
        <div class="ai-needs sp-tr-needs hidden" id="sp-tr-needs"></div>
        <ol class="sp-posts" id="sp-posts"></ol>
        <form class="composer sp-composer" id="sp-composer">
          <textarea id="sp-text" rows="1" maxlength="4096" placeholder="Post" aria-label="Post"></textarea>
          <button class="send-btn" type="submit" title="Post" aria-label="Post"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2-6z"/></svg></button>
        </form>
        <p class="muted small sp-readonly hidden" id="sp-readonly">Only the channel's admins post here. You can react.</p>
      </div>
      <div class="sp-empty" id="sp-empty"><h2>Large groups and channels.</h2><p class="muted">Groups of up to ${TIERS.plus.groupMembers.toLocaleString('en-US')} people, end-to-end encrypted. Channels to broadcast to any number of subscribers: private ones are encrypted; public ones have a +name.veil address anyone can read.</p></div>
    </div>`;
  main.append(view);

  const plusView = el('section', 'view hidden'); plusView.id = 'view-plus';
  plusView.innerHTML = `
    <header class="view-head"><button type="button" class="icon-btn back" data-back aria-label="Back">${SVG.back}</button><h2>FabriC++ Plus</h2></header>
    <div class="settings">
      <div class="profile-card sp-plan-card"><div><div class="peer" id="pl-current"></div><div class="muted small" id="pl-until"></div></div></div>
      <table class="sp-compare"><thead><tr><th></th><th>${TIERS.free.name}<small>Free</small></th><th>${TIERS.plus.name}<small>${TIERS.plus.priceLabel}</small></th></tr></thead><tbody id="pl-rows"></tbody></table>
      <p class="muted small">Encryption is the same on both plans: Plus buys capacity and no ads, never privacy.</p>
      <div class="row"><button type="button" class="primary" id="pl-get">Get FabriC++ Plus</button></div>
      <p class="small" id="pl-msg" role="status"></p>
      <label class="pref hidden" id="pl-badge-row"><input type="checkbox" id="pl-badge" /><span>Show the Plus mark on my profile<small>Others see a small mark next to your +name. They don't see anything else about your plan.</small></span></label>
    </div>`;
  main.append(plusView);

  const dlg = (id, html) => { const d = el('dialog', 'fwd-dialog sp-dialog'); d.id = id; d.innerHTML = html; document.body.append(d); return d; };
  const createDlg = dlg('sp-create', `
    <h3 id="spc-title">New channel</h3>
    <label class="field"><span>Name</span><input id="spc-name" maxlength="64" autocomplete="off" enterkeyhint="go" placeholder="Name" /></label>
    <fieldset class="sp-vis" id="spc-vis">
      <label class="pref"><input type="radio" name="spc-vis" value="private" checked /><span>Private<small>End-to-end encrypted. People join with an invite link; the key travels in the link and never reaches the relay.</small></span></label>
      <label class="pref"><input type="radio" name="spc-vis" value="public" /><span>Public<small>Anyone can find and read it at its +name.veil address. <strong>Not end-to-end encrypted</strong>: there is no way to encrypt to readers nobody knows, so the relay stores public posts as plain text.</small></span></label>
    </fieldset>
    <label class="field hidden" id="spc-handle-row"><span>Address</span><input id="spc-handle" maxlength="30" autocomplete="off" enterkeyhint="go" placeholder="+name.veil" /></label>
    <label class="field hidden" id="spc-topic-row"><span>Topic</span><select id="spc-topic">${TOPICS.map((t) => `<option value="${t}">${t[0].toUpperCase()}${t.slice(1)}</option>`).join('')}</select><small class="muted">Sponsored posts here are matched to the topic, never to readers.</small></label>
    <label class="field"><span>About</span><input id="spc-about" maxlength="280" autocomplete="off" enterkeyhint="go" placeholder="Optional" /></label>
    <p class="muted small" id="spc-note"></p>
    <p id="spc-error" class="error small"></p>
    <div class="dialog-actions"><button class="ghost" type="button" id="spc-cancel">Cancel</button><button class="primary" type="button" id="spc-ok">Create</button></div>`);
  const joinDlg = dlg('sp-join', `
    <h3>Join a channel or group</h3>
    <label class="field"><span>Public address or invite link</span><input id="spj-in" autocomplete="off" enterkeyhint="go" placeholder="+name.veil or invite link" /></label>
    <div id="spj-preview" class="sp-preview"></div>
    <p id="spj-error" class="error small"></p>
    <div class="dialog-actions"><button class="ghost" type="button" id="spj-cancel">Cancel</button><button class="primary" type="button" id="spj-ok">Look up</button></div>`);
  const infoDlg = dlg('sp-info', '<div id="spi-body"></div><div class="dialog-actions"><button class="ghost" type="button" id="spi-close">Close</button></div>');
  const whyDlg = dlg('sp-why', '<h3>Why am I seeing this?</h3><ul id="spw-list" class="sp-why"></ul><div class="dialog-actions"><button class="ghost" type="button" id="spw-plus">No ads with Plus</button><button class="primary" type="button" id="spw-close">OK</button></div>');
  for (const d of [createDlg, joinDlg, infoDlg, whyDlg]) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  // Enter in a one-line field submits, so a phone keyboard covering the buttons doesn't strand you
  for (const [d, ok] of [[createDlg, 'spc-ok'], [joinDlg, 'spj-ok']]) {
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.target.matches('input:not([type=radio]):not([type=checkbox])')) { e.preventDefault(); e.target.blur(); $(ok).click(); }
    });
  }

  // + sheet and Settings entries
  const sheet = $('new-sheet');
  if (sheet) {
    const groupItem = sheet.querySelector('[data-new="group"] small');
    if (groupItem) groupItem.textContent = 'Up to 64 people · more in a large group';
    const item = (kind, svg, title, sub) => {
      const b = btn('sheet-item', null, () => { sheet.close(); kind === 'list' ? show() : openCreate(kind); });
      b.dataset.sp = kind;
      b.innerHTML = `<span class="sheet-ico">${svg}</span><span><strong>${title}</strong><small>${sub}</small></span>`;
      return b;
    };
    const after = sheet.querySelector('[data-new="group"]');
    after?.after(item('channel', SVG.channel, 'New channel', 'Broadcast to subscribers · public or private'),
      item('group', SVG.group, 'New large group', `Up to ${TIERS.plus.groupMembers.toLocaleString('en-US')} people · encrypted`),
      item('list', SVG.channel, 'Channels and groups', 'Yours, and join by address or link'));
  }
  const settingsList = document.querySelector('#view-settings .settings-list');
  if (settingsList) {
    const li = (go, title, sub) => { const l = el('li'); const b = btn('', null, () => switchTab(go)); b.innerHTML = `<span>${title}</span><small>${sub}</small>`; l.append(b); return l; };
    settingsList.prepend(li('plus', 'FabriC++ Plus', 'Plan, limits, no ads'), li('spaces', 'Channels and large groups', 'Broadcast and large encrypted groups'));
  }
  for (const b of view.querySelectorAll('[data-back]')) b.onclick = () => switchTab('chats');
  plusView.querySelector('[data-back]').onclick = () => switchTab('settings');

  // ---------- list ----------
  function renderList() {
    const ul = $('sp-list');
    ul.replaceChildren();
    if (!spaces.length) ul.append(el('li', 'contacts-empty', 'No channels or large groups yet.'));
    for (const s of [...spaces].sort((a, b) => b.lastAt - a.lastAt)) {
      const li = el('li', s.id === openSid ? 'active' : '');
      li.append(icon(s.kind === 'channel' ? SVG.channel : SVG.group, 'sp-avatar'));
      const m = el('div', 'contact-main');
      const top = el('div', 'contact-top');
      top.append(el('span', 'contact-name', s.name), el('span', 'contact-time muted small', fmtTime(s.lastAt)));
      const kind = s.kind === 'group' ? 'Large group' : s.visibility === 'public' ? `Public channel · ${showHandle(s.handle)}` : 'Private channel';
      m.append(top, el('div', 'contact-sub muted small', `${kind} · ${fmtCount(s.members)} ${s.kind === 'channel' ? 'subscribers' : 'members'}${s.e2ee ? ' · 🔒' : ''}`));
      li.append(m);
      li.onclick = () => openSpace(s.id);
      ul.append(li);
    }
  }

  async function refresh() {
    try { spaces = (await request({ type: 'space_list' })).spaces; } catch { return; }
    renderList();
    if (openSid && !cur()) closeSpace();
  }

  function show() { switchTab('spaces'); }

  // ---------- one space ----------
  async function openSpace(sid) {
    openSid = sid;
    $('sp-feed').classList.remove('hidden');
    $('sp-empty').classList.add('hidden');
    view.classList.add('sp-open');
    renderList(); renderHead();
    $('sp-posts').replaceChildren(el('li', 'muted small sp-loading', 'Loading…'));
    try { posts = (await request({ type: 'space_posts', sid })).posts; } catch (e) { toast(e.message); return; }
    await decryptAll(posts);
    renderPosts();
    markViewed();
    loadChannelAd();
  }
  function closeSpace() {
    openSid = null; posts = []; channelAd = null;
    $('sp-feed').classList.add('hidden');
    $('sp-empty').classList.remove('hidden');
    view.classList.remove('sp-open');
    renderList();
  }

  function renderHead() {
    const s = cur(); if (!s) return;
    $('sp-title').textContent = s.name;
    const kind = s.kind === 'group' ? 'Large group' : s.visibility === 'public' ? showHandle(s.handle) : 'Private channel';
    $('sp-sub').textContent = `${kind} · ${s.members.toLocaleString('en-US')} ${s.kind === 'channel' ? 'subscribers' : 'members'}`;
    const p = $('sp-privacy');
    p.className = `sp-privacy ${s.e2ee ? 'ok' : 'open'}`;
    p.textContent = s.e2ee
      ? (keyFor(s.id, s.epoch) ? '🔒 End-to-end encrypted. The relay stores only ciphertext; it does see who is a member and when posts are made.' : '🔒 End-to-end encrypted. Waiting for the current key from an admin: new posts can’t be read on this device yet.')
      : 'Public channel: not end-to-end encrypted. Anyone can read these posts, including the relay. Don’t post anything private here.';
    const mayPost = can(s.role, 'post', s.kind);
    $('sp-composer').classList.toggle('hidden', !mayPost);
    $('sp-readonly').classList.toggle('hidden', mayPost);
  }

  async function decryptAll(list) {
    const s = cur();
    for (const p of list) {
      if (!s?.e2ee) { p.plain = { t: p.body.text }; continue; }
      const k = keyFor(p.sid, p.body.e);
      if (!k) { p.plain = null; continue; }
      try { p.plain = await openPost(k, p.sid, p.body); } catch { p.plain = null; }
    }
  }

  let channelAd = null;
  function postEl(p) {
    const s = cur();
    const li = el('li', 'sp-post');
    li.dataset.seq = p.seq;
    const head = el('div', 'sp-post-head muted small');
    head.append(el('span', 'sp-author', s.kind === 'group' ? showHandle(p.author || '') : s.name));
    if (p.author && s.kind === 'channel') head.append(el('span', 'sp-signed', ` · by ${showHandle(p.author)}`));
    head.append(el('span', 'sp-time', ` · ${fmtTime(p.at)}`));
    li.append(head);
    if (p.plain) {
      if (p.plain.t) {
        const tr = translatedPost(p);
        li.append(el('div', 'sp-text', tr ? tr.text : p.plain.t));
        if (tr) li.append(tl.noteEl(tr, p.plain.t, `p:${p.sid}:${p.seq}`, () => redrawPost(p)));
      }
      if (p.plain.img && /^image\/(png|jpeg|gif|webp)$/.test(p.plain.img.mime)) {
        const img = el('img', 'sp-img'); img.alt = 'Photo'; img.src = `data:${p.plain.img.mime};base64,${p.plain.img.data}`;
        li.append(img);
      }
    } else li.append(el('div', 'sp-text muted', '🔒 Can’t read this post on this device (no key for it).'));
    const foot = el('div', 'sp-foot');
    const reacts = el('div', 'sp-reacts');
    for (const [emoji, n] of Object.entries(p.reactions || {})) {
      reacts.append(btn(`sp-react${p.mine === emoji ? ' mine' : ''}`, `${emoji} ${fmtCount(n)}`, () => react(p, p.mine === emoji ? null : emoji), p.mine === emoji ? 'Remove your reaction' : `React ${emoji}`));
    }
    const add = btn('sp-react sp-react-add', '+', () => {
      const pick = el('div', 'sp-pick');
      for (const r of REACTIONS) pick.append(btn('sp-react', r, () => { pick.remove(); react(p, r); }, `React ${r}`));
      reacts.after(pick);
      add.disabled = true;
    }, 'Add a reaction');
    reacts.append(add);
    const views = el('span', 'sp-views muted small');
    views.append(icon(SVG.eye), document.createTextNode(fmtCount(p.views)));
    views.title = `${p.views.toLocaleString('en-US')} views`;
    foot.append(reacts, views);
    if (p.author === me() || can(s.role, 'delete_post', s.kind)) foot.append(btn('sp-del ghost small', 'Delete', () => delPost(p)));
    li.append(foot);
    return li;
  }

  // ---------- automatic translation of posts (on this device; text never leaves it) ----------
  const trCache = () => (vault.get().spaceTr ??= {});
  const trKey = (p) => `${p.sid}:${p.seq}`;
  const trQueue = [];
  let trRunning = false;
  let trNeeds = null; // { sid, from }: a model to download first
  let trAsk = null;   // { sid, from }: the one-time question
  /** The cached translation to show for a post, or null (and queue it if not looked at yet). */
  function translatedPost(p) {
    if (!tl || !p.plain?.t?.trim() || p.author === me() || !tl.on(p.sid)) return null;
    const c = cacheGet(trCache(), trKey(p), p.plain.t);
    if (c) return c.from ? c : null;
    if (!trQueue.includes(p)) trQueue.push(p);
    runQueue();
    return null;
  }
  async function runQueue(opts = {}) {
    if (trRunning && !opts.allowDownload) return;
    trRunning = true;
    try {
      while (trQueue.length) {
        const p = trQueue.shift();
        if (p.sid !== openSid || !tl.on(p.sid)) continue;
        const text = p.plain?.t;
        if (!text || cacheGet(trCache(), trKey(p), text)) continue;
        let r;
        try { r = await tl.translate(text, opts); } catch (e) { console.warn('on-device translation failed', e); continue; }
        if (r?.needsDownload) {
          if (!trNeeds) { trNeeds = { sid: p.sid, from: r.from }; renderTrBar(); }
          continue;
        }
        cachePut(trCache(), trKey(p), text, r ? { from: r.from, text: String(r.text).slice(0, 8000) } : { from: null, text: null });
        vault.save();
        if (r && tl.shouldAsk() && !trAsk) { trAsk = { sid: p.sid, from: r.from }; renderTrBar(); }
        if (r) redrawPost(p);
      }
    } finally { trRunning = false; }
  }
  function redrawPost(p) {
    const li = $('sp-posts').querySelector(`li.sp-post[data-seq="${p.seq}"]`);
    if (li && p.sid === openSid) li.replaceWith(postEl(p));
  }
  function renderTrBar() {
    const box = $('sp-tr-needs');
    const b = $('sp-tr-btn');
    const s = cur();
    b.classList.toggle('hidden', !tl || !s);
    if (!tl || !s) return box.classList.add('hidden');
    const on = tl.on(s.id);
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? 'Translating' : 'Translate';
    b.title = on ? 'Turn off automatic translation here' : 'Translate posts here, on this device';
    if (trAsk && trAsk.sid === s.id) {
      box.replaceChildren(el('span', '', `Translated from ${tl.name(trAsk.from)} into ${tl.name(tl.target())} on this device. Posts never leave it for translation. Keep translating automatically?`),
        btn('ghost', 'Keep translating', () => { tl.answer(true); trAsk = null; renderTrBar(); }),
        btn('ghost', 'Turn off', () => { tl.answer(false); trAsk = null; renderTrBar(); renderPosts(); }));
      box.classList.remove('hidden');
    } else if (trNeeds && trNeeds.sid === s.id && on) {
      const mb = tl.mb(trNeeds.from);
      const dl = btn('ghost', 'Download', async () => {
        dl.disabled = true;
        trNeeds = null;
        trQueue.splice(0, trQueue.length, ...posts.filter((x) => x.sid === openSid));
        try { await runQueue({ allowDownload: true, onProgress: (x) => { dl.textContent = `Downloading… ${Math.round(x * 100)}%`; } }); } catch (e) { toast(e.message); }
        renderTrBar();
      });
      box.replaceChildren(el('span', '', `Translating ${tl.name(trNeeds.from)} needs a one-time download of the on-device translation model${mb ? ` (about ${mb} MB)` : ''}. It runs on this device; posts are never sent anywhere to be translated.`),
        dl, btn('ghost', 'Not now', () => { trNeeds = null; renderTrBar(); }));
      box.classList.remove('hidden');
    } else box.classList.add('hidden');
  }
  $('sp-tr-btn').onclick = () => {
    const s = cur();
    if (!s || !tl) return;
    tl.toggle(s.id);
    if (trAsk) { tl.answer(true); trAsk = null; } // they've made a choice
    renderTrBar(); renderPosts();
  };

  function adEl(ad, onHide) {
    const li = el('li', 'sp-ad');
    const head = el('div', 'sp-ad-head');
    head.append(el('span', 'sp-ad-label', ad.label), el('span', 'muted small', ad.advertiser));
    const why = btn('sp-ad-why', 'Why this ad?', () => openWhy(ad));
    const hide = btn('sp-ad-hide', '✕', onHide, 'Hide this sponsored post');
    head.append(why, hide);
    li.append(head, el('strong', 'sp-ad-title', ad.headline));
    if (ad.body) li.append(el('div', 'sp-ad-body small', ad.body));
    const go = btn('ghost sp-ad-cta', `${ad.cta} ↗`, async () => {
      try { const r = await request({ type: 'ads_click', id: ad.id }); window.open(r.url, '_blank', 'noopener,noreferrer'); } catch (e) { toast(e.message); }
    });
    li.append(go);
    return li;
  }
  function openWhy(ad) {
    const ul = $('spw-list'); ul.replaceChildren();
    for (const w of ad.why) ul.append(el('li', '', w));
    whyDlg.showModal();
  }

  function renderPosts() {
    renderTrBar();
    const ol = $('sp-posts');
    ol.replaceChildren();
    if (!posts.length) ol.append(el('li', 'muted small sp-loading', cur()?.kind === 'channel' ? 'No posts yet.' : 'No messages yet. Say hello.'));
    posts.forEach((p, i) => {
      ol.append(postEl(p));
      // one sponsored post in a public channel, after the third post (or at the end)
      if (channelAd && (i === Math.min(2, posts.length - 1))) ol.append(adEl(channelAd, () => { channelAd = null; renderPosts(); }));
    });
    ol.scrollTop = ol.scrollHeight;
  }

  async function loadChannelAd() {
    const s = cur();
    channelAd = null;
    if (!s || s.visibility !== 'public' || !plan?.plan?.ads) return;
    try { channelAd = (await request({ type: 'ads_fetch', placement: 'channel', sid: s.id })).ad; } catch { channelAd = null; }
    if (channelAd && cur()?.id === s.id) renderPosts();
  }

  async function markViewed() {
    const s = cur(); if (!s || !posts.length) return;
    try {
      const r = await request({ type: 'space_view', sid: s.id, seqs: posts.map((p) => p.seq).slice(-100) });
      for (const p of posts) if (r.views[p.seq] != null) p.views = r.views[p.seq];
      for (const li of $('sp-posts').querySelectorAll('.sp-post')) {
        const p = posts.find((x) => String(x.seq) === li.dataset.seq);
        const v = li.querySelector('.sp-views');
        if (p && v) { v.lastChild.textContent = fmtCount(p.views); v.title = `${p.views.toLocaleString('en-US')} views`; }
      }
    } catch { /* counts are best effort */ }
  }

  async function react(p, emoji) {
    try {
      const r = await request({ type: 'space_react', sid: p.sid, seq: p.seq, emoji });
      p.reactions = r.reactions; p.mine = r.mine;
      renderPosts();
    } catch (e) { toast(e.message); }
  }
  async function delPost(p) {
    if (!confirm('Delete this post for everyone?')) return;
    try { await request({ type: 'space_delete_post', sid: p.sid, seq: p.seq }); } catch (e) { toast(e.message); }
  }

  $('sp-composer').onsubmit = async (e) => {
    e.preventDefault();
    const s = cur(); const t = $('sp-text').value.trim();
    if (!s || !t) return;
    try {
      let body;
      if (s.e2ee) {
        const k = keyFor(s.id, s.epoch);
        if (!k) throw new Error('No key for this space on this device yet.');
        body = await sealPost(k, s.id, s.epoch, { t });
      } else body = { text: t };
      $('sp-text').value = '';
      await request({ type: 'space_post', sid: s.id, id: newId(), body });
    } catch (err) {
      toast(/stale key epoch/.test(err.message) ? 'The key just changed. Wait for it, then send again.' : err.message);
    }
  };
  $('sp-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('sp-composer').requestSubmit(); } });
  $('sp-close').onclick = closeSpace;

  // ---------- create / join ----------
  let createKind = 'channel';
  function openCreate(kind) {
    createKind = kind;
    switchTab('spaces');
    $('spc-title').textContent = kind === 'channel' ? 'New channel' : 'New large group';
    $('spc-vis').classList.toggle('hidden', kind !== 'channel');
    createDlg.querySelector('input[value="private"]').checked = true;
    for (const id of ['spc-name', 'spc-handle', 'spc-about']) $(id).value = '';
    $('spc-error').textContent = '';
    syncCreate();
    createDlg.showModal();
  }
  function syncCreate() {
    const pub = createKind === 'channel' && createDlg.querySelector('input[name="spc-vis"]:checked').value === 'public';
    $('spc-handle-row').classList.toggle('hidden', !pub);
    $('spc-topic-row').classList.toggle('hidden', !pub);
    const cap = (plan?.plan || TIERS.free);
    $('spc-note').textContent = createKind === 'group'
      ? `End-to-end encrypted. Up to ${cap.groupMembers.toLocaleString('en-US')} members on your plan. The relay keeps the member list (so it can deliver one copy to everyone) but can't read posts. For up to 64 people with no relay-side list at all, use New group.`
      : pub ? 'Public: readable by anyone, so not end-to-end encrypted. Admins post; subscribers read and react.' : 'Admins post; subscribers read and react. Encrypted with a key only subscribers hold.';
  }
  for (const r of createDlg.querySelectorAll('input[name="spc-vis"]')) r.onchange = syncCreate;
  $('spc-cancel').onclick = () => createDlg.close();
  $('spc-ok').onclick = async () => {
    const pub = createKind === 'channel' && createDlg.querySelector('input[name="spc-vis"]:checked').value === 'public';
    try {
      if (pub && !channelHandle($('spc-handle').value)) throw new Error('Pick an address like +name.veil (2–24 letters, digits or _).');
      const { space } = await request({
        type: 'space_create', kind: createKind, visibility: pub ? 'public' : 'private', name: $('spc-name').value, about: $('spc-about').value,
        ...(pub ? { handle: $('spc-handle').value, topic: $('spc-topic').value } : {}),
      });
      if (!pub) saveKey(space.id, space.epoch, await newKey());
      createDlg.close();
      spaces.push(space);
      await openSpace(space.id);
      openInfo();
    } catch (e) { $('spc-error').textContent = e.message; }
  };

  let joinTarget = null;
  function parseJoin(text) {
    const t = String(text || '').trim();
    const frag = /#join=([^\s]+)$/.exec(t)?.[1] || t;
    const inv = /^([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{40,})$/.exec(frag);
    if (inv) return { invite: inv[1], key: unb64url(inv[2]) };
    const h = channelHandle(decodeURIComponent(frag));
    return h ? { handle: h } : null;
  }
  function openJoin(prefill = '') {
    switchTab('spaces');
    $('spj-in').value = prefill; $('spj-error').textContent = ''; $('spj-preview').replaceChildren();
    $('spj-ok').textContent = 'Look up'; joinTarget = null;
    joinDlg.showModal();
    if (prefill) $('spj-ok').click();
  }
  $('spj-cancel').onclick = () => joinDlg.close();
  $('spj-in').oninput = () => { joinTarget = null; $('spj-ok').textContent = 'Look up'; $('spj-preview').replaceChildren(); };
  $('spj-ok').onclick = async () => {
    $('spj-error').textContent = '';
    try {
      if (!joinTarget) {
        const t = parseJoin($('spj-in').value);
        if (!t) throw new Error('Paste an invite link, or type a public address like +name.veil.');
        const { space } = await request({ type: 'space_resolve', ...(t.invite ? { invite: t.invite } : { handle: t.handle }) });
        joinTarget = { ...t, space };
        const pv = $('spj-preview'); pv.replaceChildren();
        pv.append(el('strong', '', space.name), el('div', 'muted small', `${space.kind === 'group' ? 'Large group' : space.visibility === 'public' ? `Public channel · ${showHandle(space.handle)}` : 'Private channel'} · ${space.members.toLocaleString('en-US')} ${space.kind === 'channel' ? 'subscribers' : 'members'}`));
        if (space.about) pv.append(el('p', 'small', space.about));
        pv.append(el('p', `small sp-privacy ${space.e2ee ? 'ok' : 'open'}`, space.e2ee ? '🔒 End-to-end encrypted.' : 'Public: not end-to-end encrypted. Anyone can read it.'));
        $('spj-ok').textContent = space.role ? 'Open' : space.kind === 'channel' ? 'Subscribe' : 'Join';
        return;
      }
      const t = joinTarget;
      if (!t.space.role) await request({ type: 'space_join', ...(t.invite ? { invite: t.invite } : { handle: t.handle }) });
      if (t.key) saveKey(t.space.id, t.space.epoch, t.key);
      joinDlg.close();
      await refresh();
      await openSpace(t.space.id);
    } catch (e) { $('spj-error').textContent = e.message; }
  };
  $('sp-new-channel').onclick = () => openCreate('channel');
  $('sp-new-group').onclick = () => openCreate('group');
  $('sp-join-btn').onclick = () => openJoin();

  // ---------- info: invites, members, roles, settings ----------
  const linkFor = (s, code) => {
    if (!code) return `${location.origin}/#join=${showHandle(s.handle)}`;
    const k = keyFor(s.id, s.epoch);
    return `${location.origin}/#join=${code}.${b64url(k)}`;
  };
  async function openInfo() {
    const s = cur(); if (!s) return;
    const box = $('spi-body'); box.replaceChildren();
    box.append(el('h3', '', s.name));
    if (s.about) box.append(el('p', 'small', s.about));
    box.append(el('p', `small sp-privacy ${s.e2ee ? 'ok' : 'open'}`, s.e2ee
      ? '🔒 End-to-end encrypted. Removing someone stops the relay serving them at once; your device then makes a new key and sends it to everyone else over their encrypted one-to-one sessions.'
      : 'Public channel: not end-to-end encrypted. Anyone with the address can read every post.'));
    const admin = can(s.role, 'invite', s.kind);
    if (s.visibility === 'public') {
      const row = el('div', 'sp-linkrow');
      row.append(el('code', 'mono small', linkFor(s)), btn('ghost', 'Copy', () => copy(linkFor(s))));
      box.append(el('div', 'eyebrow', 'Public link'), row);
    }
    if (admin && s.e2ee) {
      box.append(el('div', 'eyebrow', 'Invite links'));
      const list = el('ul', 'sp-invites');
      const reload = async () => {
        list.replaceChildren();
        const { invites } = await request({ type: 'space_invites', sid: s.id });
        for (const i of invites.filter((x) => !x.revoked)) {
          const li = el('li', 'sp-linkrow');
          li.append(el('code', 'mono small', linkFor(s, i.code)), el('span', 'muted small', `${i.uses}${i.maxUses ? `/${i.maxUses}` : ''} used${i.expiresAt ? ` · until ${fmtTime(i.expiresAt)}` : ''}`),
            btn('ghost', 'Copy', () => copy(linkFor(s, i.code))), btn('ghost', 'Revoke', async () => { await request({ type: 'space_invite_revoke', sid: s.id, code: i.code }); reload(); }));
          list.append(li);
        }
        if (!list.children.length) list.append(el('li', 'muted small', 'No active links.'));
      };
      box.append(list, btn('ghost', 'New invite link', async () => { await request({ type: 'space_invite_create', sid: s.id }); reload(); }));
      box.append(el('p', 'muted small', 'The link carries the key after the #, which browsers never send to the relay. Share it only with people who should read this space.'));
      reload().catch((e) => toast(e.message));
    }
    if (can(s.role, 'edit', s.kind) && s.visibility === 'public') {
      const lab = el('label', 'pref');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = s.ads;
      cb.onchange = async () => { try { Object.assign(s, (await request({ type: 'space_edit', sid: s.id, ads: cb.checked })).space); } catch (e) { toast(e.message); } };
      const sp = el('span', '', 'Sponsored posts in this channel');
      sp.append(el('small', '', `Matched to the topic (${s.topic || 'none'}) only. Readers on Plus never see them.`));
      lab.append(cb, sp);
      box.append(lab);
    }
    if (s.kind === 'group' || admin) {
      box.append(el('div', 'eyebrow', s.kind === 'channel' ? 'Subscribers' : 'Members'));
      const ul = el('ul', 'sp-members');
      box.append(ul);
      try {
        const { members, total } = await request({ type: 'space_members', sid: s.id });
        for (const m of members) {
          const li = el('li');
          li.append(el('span', 'contact-name', showHandle(m.handle)), el('span', 'muted small', m.role === 'member' ? '' : m.role));
          if (s.role === 'owner' && m.role !== 'owner') li.append(btn('ghost small', m.role === 'admin' ? 'Make member' : 'Make admin', async () => { await request({ type: 'space_role', sid: s.id, handle: m.handle, role: m.role === 'admin' ? 'member' : 'admin' }); openInfo(); }));
          if (admin && m.role !== 'owner' && m.handle !== me() && (m.role === 'member' || s.role === 'owner')) li.append(btn('ghost small', 'Remove', () => removeMember(s, m.handle)));
          ul.append(li);
        }
        if (total > members.length) ul.append(el('li', 'muted small', `and ${(total - members.length).toLocaleString('en-US')} more`));
      } catch (e) { ul.append(el('li', 'muted small', e.message)); }
    }
    const end = el('div', 'row');
    if (s.role === 'owner') end.append(btn('ghost danger', s.kind === 'channel' ? 'Delete channel' : 'Delete group', async () => { if (confirm(`Delete “${s.name}” and all its posts for everyone? This can't be undone.`)) { await request({ type: 'space_remove_space', sid: s.id }); infoDlg.close(); } }));
    else end.append(btn('ghost danger', s.kind === 'channel' ? 'Unsubscribe' : 'Leave group', async () => { await request({ type: 'space_leave', sid: s.id }); infoDlg.close(); closeSpace(); refresh(); }));
    box.append(end);
    if (!infoDlg.open) infoDlg.showModal();
  }
  $('sp-info-btn').onclick = openInfo;
  $('spi-close').onclick = () => infoDlg.close();
  $('spw-close').onclick = () => whyDlg.close();
  $('spw-plus').onclick = () => { whyDlg.close(); switchTab('plus'); };
  async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { prompt('Copy this link', text); } }

  async function removeMember(s, h) {
    if (!confirm(`Remove ${showHandle(h)}? They won't be able to rejoin with a link.`)) return;
    try {
      const r = await request({ type: 'space_remove', sid: s.id, handle: h });
      if (r.rotate) await rotate(s);
      openInfo();
    } catch (e) { toast(e.message); }
  }
  /** New key epoch: tell the relay, then send the key to every member end to end. */
  async function rotate(s) {
    const k = await newKey();
    const r = await request({ type: 'space_rotate', sid: s.id });
    saveKey(s.id, r.epoch, k);
    s.epoch = r.epoch;
    let sent = 0;
    for (const h of r.members.filter((x) => x !== me())) {
      try { await sendKey(h, { kind: 'space_key', sid: s.id, epoch: r.epoch, key: k }); sent++; } catch { /* offline contact: they get it when an admin rotates again */ }
    }
    await sendKey(me(), { kind: 'space_key', sid: s.id, epoch: r.epoch, key: k }).catch(() => {}); // my other devices
    toast(`New key sent to ${sent} member${sent === 1 ? '' : 's'}`);
    renderHead();
  }

  // ---------- Plus ----------
  function renderPlus() {
    const p = plan?.plan || { ...TIERS.free, tier: 'free' };
    $('pl-current').textContent = p.tier === 'plus' ? 'You have FabriC++ Plus' : 'You are on the free plan';
    $('pl-until').textContent = p.expiresAt ? `Until ${new Date(p.expiresAt).toLocaleDateString()}${p.source === 'stub' ? ' · test activation, no payment' : p.source === 'stripe-test' ? ' · Stripe test mode' : ''}` : 'Free, with one sponsored slot in your chat list.';
    const rows = $('pl-rows'); rows.replaceChildren();
    for (const [label, f, pl] of compareRows((n) => `${Math.round(n / MB)} MB`)) {
      const tr = el('tr'); tr.append(el('th', '', label), el('td', p.tier === 'free' ? 'cur' : '', f), el('td', p.tier === 'plus' ? 'cur' : '', pl)); rows.append(tr);
    }
    const get = $('pl-get');
    get.classList.toggle('hidden', p.tier === 'plus');
    get.disabled = !plan?.checkout;
    $('pl-msg').textContent = p.tier === 'plus' ? '' : !plan?.checkout
      ? 'Payments are switched off on this relay. Nothing can be charged.'
      : plan.payments === 'stub' ? 'Test activation: this relay grants Plus for 30 days with no payment. No card, no charge.'
        : 'Stripe TEST MODE: the checkout page takes only Stripe test cards. No real card is charged.';
    $('pl-badge-row').classList.toggle('hidden', p.tier !== 'plus');
    $('pl-badge').checked = Boolean(p.showBadge);
    renderBadge();
  }
  $('pl-get').onclick = async () => {
    try {
      const r = await request({ type: 'plus_checkout' });
      if (r.stub) { toast('FabriC++ Plus is on (test activation, no payment)'); return; }
      $('pl-msg').textContent = 'Opened the Stripe test-mode checkout. Plus turns on here when Stripe confirms the test payment.';
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (e) { $('pl-msg').textContent = e.message; }
  };
  $('pl-badge').onchange = async () => { try { plan = await request({ type: 'plus_badge', show: $('pl-badge').checked }); renderPlus(); } catch (e) { toast(e.message); } };
  function renderBadge() {
    const showMark = Boolean(plan?.plan?.showBadge);
    for (const id of ['me', 'settings-handle']) {
      const host = $(id); if (!host) continue;
      let m = host.parentElement.querySelector(`.sp-badge[data-for="${id}"]`);
      if (showMark && !m) { m = el('span', 'sp-badge', 'Plus'); m.dataset.for = id; m.title = 'FabriC++ Plus'; host.after(m); }
      if (!showMark && m) m.remove();
    }
  }

  // ---------- sponsored slot in the chat list (free plan only) ----------
  async function loadChatAd() {
    if (!plan?.plan?.ads || chatAdHidden) { chatAd = null; return; }
    if (Date.now() - chatAdAt < 30 * 60_000) return;
    chatAdAt = Date.now();
    try { chatAd = (await request({ type: 'ads_fetch', placement: 'chatlist' })).ad; } catch { chatAd = null; }
    const ul = $('contacts'); if (ul) chatListAd(ul);
  }
  function chatListAd(ul) {
    ul.querySelector('.sp-ad')?.remove();
    if (!chatAd || chatAdHidden || !plan?.plan?.ads) return;
    const li = adEl(chatAd, () => { chatAdHidden = true; ul.querySelector('.sp-ad')?.remove(); });
    li.classList.add('sp-ad-list');
    const rows = [...ul.children].filter((c) => !c.classList.contains('archived-row'));
    const at = rows[Math.min(2, rows.length - 1)];
    if (at) at.after(li); else ul.append(li);
  }

  // ---------- relay events ----------
  function onRelay(msg) {
    switch (msg.type) {
      case 'plus_status':
        plan = msg; renderPlus();
        if (!plan.plan.ads) { chatAd = null; $('contacts')?.querySelector('.sp-ad')?.remove(); } else loadChatAd();
        return true;
      case 'space_post': {
        const s = spaces.find((x) => x.id === msg.post.sid);
        if (s) { s.lastAt = msg.post.at; s.lastSeq = msg.post.seq; }
        if (msg.post.sid === openSid && !posts.some((p) => p.seq === msg.post.seq)) {
          posts.push(msg.post);
          decryptAll([msg.post]).then(() => { renderPosts(); markViewed(); });
        } else if (!s) refresh(); else renderList();
        return true;
      }
      case 'space_unpost':
        if (msg.sid === openSid) { posts = posts.filter((p) => p.seq !== msg.seq); renderPosts(); }
        return true;
      case 'space_reacted': {
        const p = msg.sid === openSid && posts.find((x) => x.seq === msg.seq);
        if (p) { p.reactions = msg.reactions; if (msg.mine !== undefined) p.mine = msg.mine; renderPosts(); }
        return true;
      }
      case 'space_epoch': {
        const s = spaces.find((x) => x.id === msg.sid);
        if (s) { s.epoch = msg.epoch; if (s.id === openSid) renderHead(); }
        return true;
      }
      case 'space_member': {
        const s = spaces.find((x) => x.id === msg.sid);
        if (s) {
          s.members += msg.op === 'join' ? 1 : -1;
          if (s.id === openSid) renderHead();
          // someone left a private group: its owner's device changes the key
          if (msg.op === 'leave' && s.role === 'owner' && s.e2ee) rotate(s).catch(() => {});
        }
        return true;
      }
      case 'space_role': case 'space_gone':
        refresh();
        if (msg.type === 'space_gone' && msg.sid === openSid) { closeSpace(); toast('You are no longer in that space'); }
        return true;
      default:
        return false;
    }
  }

  /** A space key from another member's device (or my own), over an end-to-end encrypted session. */
  function onKey(payload, from) {
    if (typeof payload.sid !== 'string' || !Number.isInteger(payload.epoch) || typeof payload.key !== 'string' || payload.key.length !== 44) return;
    const s = spaces.find((x) => x.id === payload.sid);
    // only for a space I'm in, and only the epoch the relay says is current (from a member: the
    // relay refuses posts under any other epoch, so a bogus key can't be used to post)
    if (!s || (s.epoch !== payload.epoch && from !== me())) return;
    saveKey(payload.sid, payload.epoch, payload.key);
    if (payload.sid === openSid) { renderHead(); decryptAll(posts).then(renderPosts); }
  }

  async function connected() {
    await refresh();
    const m = /^#join=(.+)$/.exec(location.hash);
    if (m) { history.replaceState(null, '', location.pathname); openJoin(`#join=${m[1]}`); }
  }

  return {
    connected, onRelay, onKey, chatListAd, show, openCreate,
    retranslate() { if (openSid) renderPosts(); },
    onShow(name) { if (name === 'spaces') refresh(); if (name === 'plus') { renderPlus(); request({ type: 'plus_status' }).then((p) => { plan = p; renderPlus(); }).catch(() => {}); } },
  };
}
