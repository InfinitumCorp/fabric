// FABRIC Phone: calls and texts with ordinary phone numbers, through the relay's Twilio account.
// Not end-to-end encrypted (the phone network can't be); the UI says so next to every action.

import { reconcile, rotate as rotateRecord, burn as burnRecord, lineFor } from '../shared/burner.js';

const $ = (id) => document.getElementById(id);
const BURN_UNDO_MS = 5000;
const E164 = /^\+[1-9]\d{6,14}$/;
const TOKEN_REFRESH_MS = 50 * 60_000; // tokens last an hour

/** "+1 (555) 123-4567", "555 123 4567" (for +1) → "+15551234567", or null. */
export function toE164(input, defaultCountry = '+1') {
  const s = String(input || '').trim();
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, '');
  let n;
  if (s.startsWith('+')) n = '+' + digits;
  else if (s.startsWith('00')) n = '+' + digits.slice(2);
  else if (defaultCountry === '+1' && digits.length === 10) n = '+1' + digits;
  else if (defaultCountry === '+1' && digits.length === 11 && digits.startsWith('1')) n = '+' + digits;
  else n = defaultCountry + digits;
  return E164.test(n) ? n : null;
}

export function formatNumber(n) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(n || '');
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : (n || '');
}

const time = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * @param {object} o
 * @param {(msg: object) => Promise<object>} o.request  request/response over the relay socket
 * @param {() => boolean} o.inCall  a FABRIC call is active (then phone calls are refused)
 * @param {{ get: () => { records: object[], byPeer: object }, save: () => void }} [o.vault]
 *   where burner records (shared/burner.js) and each conversation's number live: the encrypted vault
 */
export function createPhone({ request, inCall = () => false, vault = null }) {
  const local = { records: [], byPeer: {} };
  const book = () => { const b = vault?.get() || local; b.records ??= []; b.byPeer ??= {}; return b; };
  const save = () => vault?.save();
  const burning = new Map(); // number → timer (the few seconds you can still undo a burn)
  let status = null;     // { enabled, number, countries }
  let device = null;     // Twilio.Device
  let tokenTimer = null;
  let active = null;     // Twilio Call
  let incoming = null;   // Twilio Call ringing here
  let callInfo = null;   // { who, dir, since }
  const events = new Map(); // seq → event

  // ---------- which number ----------
  const activeBurners = () => book().records.filter((r) => r.state === 'active' && r.network === 'pstn' && !burning.has(r.number));
  const recordOf = (number) => book().records.find((r) => r.state === 'active' && r.number === number);
  const nameOf = (r) => (r.label ? `${r.label} (${formatNumber(r.number)})` : `Burner ${formatNumber(r.number)}`);
  /** The number a conversation uses: null is your main number. */
  function lineOf(peer) {
    const choice = book().byPeer[peer];
    if (choice === 'main' && status?.number) return null;
    const r = lineFor(book().records, book().byPeer, peer);
    if (r && !burning.has(r.number)) return r.number;
    if (status?.number) return null;
    return activeBurners()[0]?.number || null; // no main number: a burner is the only way out
  }
  const canPhone = () => Boolean(status?.number || activeBurners().length);

  // ---------- Twilio Voice SDK ----------
  function loadSdk() {
    if (globalThis.Twilio?.Device) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/twilio.min.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('could not load the phone library'));
      document.head.append(s);
    });
  }

  async function fetchToken() {
    return (await request({ type: 'phone_token' })).token;
  }

  async function ensureDevice() {
    if (device) return device;
    await loadSdk();
    const token = await fetchToken();
    device = new globalThis.Twilio.Device(token, { closeProtection: true, codecPreferences: ['opus', 'pcmu'] });
    device.on('incoming', onIncoming);
    device.on('error', (e) => {
      note(`Phone service error: ${e?.message || e}`);
      if (e?.code === 20101 || e?.code === 31204) { device?.destroy(); device = null; } // bad credentials: try again later, fresh
    });
    device.on('tokenWillExpire', async () => { try { device.updateToken(await fetchToken()); } catch (e) { console.warn('phone token', e); } });
    try {
      await device.register();
    } catch (e) {
      device?.destroy();
      device = null;
      throw e;
    }
    clearInterval(tokenTimer);
    tokenTimer = setInterval(async () => { try { device?.updateToken(await fetchToken()); } catch { /* retried next time */ } }, TOKEN_REFRESH_MS);
    return device;
  }

  function wire(call, who, dir) {
    active = call;
    callInfo = { who, dir, since: null };
    call.on('accept', () => { callInfo.since = Date.now(); renderCall(); });
    call.on('disconnect', () => done());
    call.on('cancel', () => done());
    call.on('reject', () => done());
    call.on('error', (e) => { note(`Call failed: ${e.message || e}`); done(); });
    renderCall();
  }

  function done() {
    active = null;
    incoming = null;
    callInfo = null;
    renderCall();
    refreshLog();
  }

  function onIncoming(call) {
    const from = call.customParameters?.get?.('from') || call.parameters?.From || 'Unknown caller';
    const via = call.customParameters?.get?.('via') || null;
    if (active || incoming || inCall()) { call.reject(); return; }
    incoming = call;
    callInfo = { who: from, dir: 'in', since: null, via };
    call.on('cancel', () => done());
    call.on('disconnect', () => done());
    renderCall();
  }

  async function dial(raw) {
    if (!canPhone()) return note('This account has no phone number yet.');
    if (active || incoming) return;
    if (inCall()) return note('Finish your FabriC++ call first.');
    const to = toE164(raw, status.countries?.[0] || '+1');
    if (!to) return note('Enter a full phone number, like +1 555 123 4567.');
    const via = lineOf(to);
    try {
      const d = await ensureDevice();
      const call = await d.connect({ params: { To: to, ...(via ? { Via: via } : {}) } });
      wire(call, to, 'out');
      if (callInfo) { callInfo.via = via; renderCall(); }
    } catch (e) {
      note(`Could not place the call: ${e.message || e}`);
    }
  }

  async function sendText(raw, text) {
    if (!canPhone()) return note('This account has no phone number yet.');
    const to = toE164(raw, status.countries?.[0] || '+1');
    if (!to) return note('Enter a full phone number, like +1 555 123 4567.');
    if (!text.trim()) return;
    const via = lineOf(to);
    try {
      const r = await request({ type: 'sms_send', to, text, ...(via ? { via } : {}) });
      events.set(r.event.seq, r.event);
      $('phone-text').value = '';
      note('Text sent.');
      renderLog();
    } catch (e) {
      note(`Text not sent: ${e.message}`);
    }
  }

  async function playVoicemail(seq, btn) {
    btn.disabled = true;
    try {
      const r = await request({ type: 'phone_voicemail', seq });
      const bytes = Uint8Array.from(atob(r.audio), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (e) {
      note(`Could not play the voicemail: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- relay events ----------
  function onStatus(s) {
    status = s;
    if (s.enabled && s.burners) {
      const b = book();
      b.records = reconcile(b.records, s.burners.lines);
      // a rotated number's conversations move to its replacement (whichever device rotated it)
      for (const r of b.records) {
        if (r.state !== 'active' || !r.rotatedFrom) continue;
        for (const [peer, id] of Object.entries(b.byPeer)) if (id === r.rotatedFrom) b.byPeer[peer] = r.id;
      }
      const live = new Set(b.records.filter((r) => r.state === 'active').map((r) => r.id));
      for (const [peer, id] of Object.entries(b.byPeer)) if (id !== 'main' && !live.has(id)) delete b.byPeer[peer];
      b.records = b.records.filter((r) => r.state === 'active' || Date.now() - r.burnedAt < 365 * 86_400_000); // a year of burned ones, for rotate history
      save();
    }
    render();
    if (s.enabled && canPhone()) {
      refreshLog();
      // be reachable for incoming calls while the app is open
      ensureDevice().catch((e) => {
        console.warn('phone not registered:', e?.message || e);
        note(`Can't reach the phone service: ${e?.message || e?.code || 'no answer'}`);
      });
    }
  }

  function onEvent(e) {
    events.set(e.seq, e);
    // someone reached you on a burner: answering them uses that burner too
    if (e.dir === 'in' && e.via && e.peer && e.peer !== 'unknown' && !book().byPeer[e.peer]) {
      const r = recordOf(e.via);
      if (r) { book().byPeer[e.peer] = r.id; save(); renderFrom(); }
    }
    renderLog();
    if (e.kind === 'sms' && e.dir === 'in') note(`New text from ${formatNumber(e.peer)}`);
    if (e.kind === 'voicemail') note(`New voicemail from ${formatNumber(e.peer)}`);
  }

  async function refreshLog() {
    try {
      const r = await request({ type: 'phone_log' });
      events.clear();
      for (const e of r.events) events.set(e.seq, e);
      renderLog();
    } catch { /* offline */ }
  }

  async function refresh() {
    try { onStatus(await request({ type: 'phone_status' })); } catch { /* offline */ }
  }

  // ---------- UI ----------
  let noteTimer = null;
  function note(text) {
    $('phone-note').textContent = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { $('phone-note').textContent = ''; }, 8000);
  }

  function render() {
    const on = Boolean(status?.enabled);
    $('phone-off').classList.toggle('hidden', on);
    $('phone-on').classList.toggle('hidden', !on);
    if (!on) return;
    $('phone-number').textContent = status.number ? formatNumber(status.number) : 'No number yet';
    $('phone-number-note').textContent = status.number
      ? 'People can call and text you here. Missed calls go to voicemail.'
      : activeBurners().length ? 'You call and text from your burner numbers.' : 'Ask the relay operator to assign you one of their numbers, or add a burner number.';
    for (const id of ['phone-call', 'phone-sms']) $(id).disabled = !canPhone();
    renderBurners();
    renderFrom();
  }

  // ---------- burner numbers ----------
  const peerOfInput = () => toE164($('phone-to').value, status?.countries?.[0] || '+1');

  /** The From list follows the number typed in: each conversation keeps its own line. */
  function renderFrom() {
    if (!status?.enabled) return;
    const sel = $('phone-from');
    const peer = peerOfInput();
    const current = peer ? lineOf(peer) : (status.number ? null : activeBurners()[0]?.number || null);
    sel.replaceChildren();
    if (status.number) sel.append(new Option(`Main number ${formatNumber(status.number)}`, ''));
    for (const r of activeBurners()) sel.append(new Option(nameOf(r), r.number));
    sel.value = current || '';
    sel.disabled = sel.options.length < 2 || !peer;
    sel.parentElement.classList.toggle('hidden', !sel.options.length);
    const r = current && recordOf(current);
    $('phone-line-note').textContent = !peer ? ''
      : r ? `This conversation uses ${nameOf(r)}. They see only this number.`
        : status.number ? 'This conversation uses your main number.' : '';
  }

  function chooseLine(number) {
    const peer = peerOfInput();
    if (!peer) return;
    const r = number && recordOf(number);
    book().byPeer[peer] = r ? r.id : 'main';
    save();
    renderBurners();
    renderFrom();
  }

  async function newBurner() {
    $('burner-new').disabled = true;
    try {
      const r = await request({ type: 'burner_create' });
      onStatus(r);
      note(`New burner number: ${formatNumber(r.line)}`);
    } catch (e) {
      note(`No new number: ${e.message}`);
    } finally {
      renderBurners();
    }
  }

  async function rotateLine(number) {
    try {
      const r = await request({ type: 'burner_rotate', number });
      const b = book();
      const old = recordOf(number);
      if (old) {
        const [burned, fresh] = rotateRecord(old, r.line);
        b.records = b.records.map((x) => (x.id === old.id ? burned : x)).concat(fresh);
        for (const [peer, id] of Object.entries(b.byPeer)) if (id === old.id) b.byPeer[peer] = fresh.id; // same conversations, new number
        save();
      }
      onStatus(r);
      note(`${formatNumber(number)} is burned; your new number is ${formatNumber(r.line)}.`);
    } catch (e) {
      note(`Could not rotate: ${e.message}`);
    }
  }

  /** One tap burns, after a few seconds in which Undo still keeps it. */
  function burnLine(number) {
    if (burning.has(number)) return;
    burning.set(number, setTimeout(async () => {
      try {
        const r = await request({ type: 'burner_burn', number });
        const b = book();
        b.records = b.records.map((x) => (x.number === number && x.state === 'active' ? burnRecord(x) : x));
        save();
        burning.delete(number);
        onStatus(r);
        note(`${formatNumber(number)} is burned.`);
      } catch (e) {
        burning.delete(number);
        note(`Could not burn ${formatNumber(number)}: ${e.message}`);
        render();
      }
    }, BURN_UNDO_MS));
    render();
  }

  function undoBurn(number) {
    clearTimeout(burning.get(number));
    burning.delete(number);
    note(`${formatNumber(number)} kept.`);
    render();
  }

  function renderBurners() {
    const b = status?.burners;
    $('burner-card').classList.toggle('hidden', !b);
    if (!b) return;
    const used = b.lines.length;
    const ends = b.bundles.length ? new Date(Math.max(...b.bundles.map((x) => x.expiresAt))).toLocaleDateString() : null;
    $('burner-slots').textContent = b.slots
      ? `${used} of ${b.slots} burner number${b.slots === 1 ? '' : 's'} in use${ends ? ` · paid until ${ends}` : ''}`
      : 'No burner numbers on this account yet. They come in bundles of 1, 2 or 5.';
    const ul = $('burner-list');
    ul.replaceChildren();
    for (const line of b.lines) {
      const r = recordOf(line.number);
      const li = document.createElement('li');
      li.className = 'burner-item';
      const num = document.createElement('span');
      num.className = 'burner-number';
      num.textContent = formatNumber(line.number);
      const label = document.createElement('input');
      label.className = 'burner-label';
      label.maxLength = 40;
      label.placeholder = 'Label (only on your devices)';
      label.value = r?.label || '';
      label.setAttribute('aria-label', `Label for ${formatNumber(line.number)}`);
      label.onchange = () => { if (r) { r.label = label.value.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 40); save(); renderFrom(); } };
      const uses = Object.values(book().byPeer).filter((id) => r && id === r.id).length;
      const meta = document.createElement('span');
      meta.className = 'muted small';
      meta.textContent = uses ? `${uses} conversation${uses === 1 ? '' : 's'}` : 'Not used yet';
      const actions = document.createElement('span');
      actions.className = 'burner-actions';
      if (burning.has(line.number)) {
        li.classList.add('burning');
        meta.textContent = 'Burning…';
        const u = document.createElement('button');
        u.className = 'ghost'; u.type = 'button'; u.textContent = 'Undo';
        u.onclick = () => undoBurn(line.number);
        actions.append(u);
      } else {
        const rot = document.createElement('button');
        rot.className = 'ghost'; rot.type = 'button'; rot.textContent = 'Rotate';
        rot.title = 'Swap for a fresh number; this one is burned';
        rot.disabled = !b.available;
        rot.onclick = () => rotateLine(line.number);
        const burnBtn = document.createElement('button');
        burnBtn.className = 'danger'; burnBtn.type = 'button'; burnBtn.textContent = 'Burn';
        burnBtn.onclick = () => burnLine(line.number);
        actions.append(rot, burnBtn);
      }
      li.append(num, label, meta, actions);
      ul.append(li);
    }
    const free = b.slots - used;
    $('burner-new').classList.toggle('hidden', !b.slots);
    $('burner-new').disabled = free <= 0 || !b.available;
    $('burner-new').title = free <= 0 ? 'Every number in your bundle is in use' : !b.available ? 'No numbers are free on this relay right now' : '';
    const shop = $('burner-shop');
    if (!b.slots) shop.classList.remove('hidden');
    $('burner-shop-toggle').classList.toggle('hidden', !b.slots);
    renderOffers();
  }

  function renderOffers() {
    const b = status?.burners;
    if (!b) return;
    const period = document.querySelector('input[name="burner-period"]:checked')?.value || 'month';
    const box = $('burner-offers');
    box.replaceChildren();
    for (const size of b.bundleSizes) {
      const card = document.createElement('div');
      card.className = 'burner-offer';
      const h = document.createElement('strong');
      h.textContent = `${size} number${size === 1 ? '' : 's'}`;
      const sub = document.createElement('div');
      sub.className = 'muted small';
      sub.textContent = period === 'year' ? 'Renews yearly' : 'Renews monthly';
      card.append(h, sub);
      if (b.checkoutUrl) {
        const a = document.createElement('a');
        a.className = 'button primary';
        a.textContent = 'Get';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        const u = new URL(b.checkoutUrl);
        u.searchParams.set('bundle', String(size));
        u.searchParams.set('period', period);
        a.href = u.href;
        card.append(a);
      }
      box.append(card);
    }
    $('burner-buy-note').textContent = b.checkoutUrl
      ? 'This opens in a new tab. Your numbers appear here once the bundle is added. Cancel anytime: numbers stay until the end of the period.'
      : 'Bundles are added to your FabriC++ plan by the relay operator. Ask them for one.';
  }


  function label(e) {
    const base = baseLabel(e);
    if (!e.via) return base;
    const r = recordOf(e.via);
    return `${base} · on ${r ? nameOf(r) : `burner ${formatNumber(e.via)}`}`;
  }

  function baseLabel(e) {
    const who = formatNumber(e.peer);
    switch (e.kind) {
      case 'call': return e.dir === 'out' ? `📞 Called ${who}` : `📞 Call from ${who}`;
      case 'missed': return `📵 Missed call from ${who}`;
      case 'voicemail': return `🎙 Voicemail from ${who} · ${e.seconds}s`;
      case 'sms': return e.dir === 'out' ? `💬 To ${who}: ${e.text}` : `💬 From ${who}: ${e.text}`;
      default: return who;
    }
  }

  function renderLog() {
    const ul = $('phone-log');
    ul.replaceChildren();
    const list = [...events.values()].sort((a, b) => b.seq - a.seq);
    for (const e of list) {
      const li = document.createElement('li');
      li.className = `phone-item phone-${e.kind} phone-${e.dir}`;
      const text = document.createElement('span');
      text.className = 'phone-item-text';
      text.textContent = label(e);
      const meta = document.createElement('span');
      meta.className = 'muted small';
      meta.textContent = time(e.at);
      li.append(text, meta);
      const actions = document.createElement('span');
      actions.className = 'phone-item-actions';
      if (e.kind === 'voicemail') {
        const b = document.createElement('button');
        b.className = 'ghost'; b.type = 'button'; b.textContent = 'Play';
        b.onclick = () => playVoicemail(e.seq, b);
        actions.append(b);
      }
      if (e.peer && e.peer !== 'unknown') {
        const b = document.createElement('button');
        b.className = 'ghost'; b.type = 'button'; b.textContent = 'Call back';
        b.onclick = () => dial(e.peer);
        const t = document.createElement('button');
        t.className = 'ghost'; t.type = 'button'; t.textContent = 'Text';
        t.onclick = () => { $('phone-to').value = formatNumber(e.peer); renderFrom(); $('phone-text').focus(); };
        actions.append(b, t);
      }
      li.append(actions);
      ul.append(li);
    }
    $('phone-empty').classList.toggle('hidden', list.length > 0);
  }

  function renderCall() {
    const bar = $('phone-call-bar');
    bar.classList.toggle('hidden', !callInfo);
    if (!callInfo) return;
    const ringing = Boolean(incoming) && !active;
    const line = callInfo.via && recordOf(callInfo.via);
    $('phone-call-who').textContent = formatNumber(callInfo.who) + (callInfo.via ? ` · ${line ? nameOf(line) : `burner ${formatNumber(callInfo.via)}`}` : '');
    $('phone-call-status').textContent = ringing ? 'Incoming phone call'
      : callInfo.since ? 'Phone call · not end-to-end encrypted' : (callInfo.dir === 'out' ? 'Calling…' : 'Connecting…');
    $('phone-answer').classList.toggle('hidden', !ringing);
    $('phone-decline').classList.toggle('hidden', !ringing);
    for (const id of ['phone-mute', 'phone-hangup', 'phone-keypad']) $(id).classList.toggle('hidden', ringing);
    $('phone-mute').textContent = active?.isMuted?.() ? 'Unmute' : 'Mute';
  }

  $('phone-dial').onsubmit = (e) => { e.preventDefault(); dial($('phone-to').value); };
  $('phone-to').addEventListener('input', () => renderFrom());
  $('phone-from').onchange = (e) => chooseLine(e.target.value);
  $('burner-new').onclick = () => newBurner();
  $('burner-shop-toggle').onclick = () => $('burner-shop').classList.toggle('hidden');
  for (const r of document.querySelectorAll('input[name="burner-period"]')) r.onchange = () => renderOffers();
  $('phone-sms').onclick = () => sendText($('phone-to').value, $('phone-text').value);
  $('phone-answer').onclick = () => {
    if (!incoming) return;
    const call = incoming;
    incoming = null;
    wire(call, callInfo.who, 'in');
    call.accept();
  };
  $('phone-decline').onclick = () => { incoming?.reject(); done(); };
  $('phone-hangup').onclick = () => { active?.disconnect(); done(); };
  $('phone-mute').onclick = () => { if (active) { active.mute(!active.isMuted()); renderCall(); } };
  $('phone-keypad').oninput = (e) => {
    const d = e.data;
    if (active && d && /^[0-9*#]$/.test(d)) active.sendDigits(d);
  };
  addEventListener('pagehide', () => {
    active?.disconnect();
    device?.destroy();
    for (const [number, t] of burning) { clearTimeout(t); request({ type: 'burner_burn', number }).catch(() => {}); } // leaving doesn't undo
  });

  return {
    refresh, onStatus, onEvent, dial,
    get status() { return status; },
    get busy() { return Boolean(active || incoming); },
  };
}
