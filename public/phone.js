// FABRIC Phone: calls and texts with ordinary phone numbers, through the relay's Twilio account.
// Not end-to-end encrypted (the phone network can't be); the UI says so next to every action.

import { reconcile, lineFor } from '../shared/burner.js';
import { newBurnCode, burnCodeHash, signBurnCode } from '../shared/burn-code.js';
import { mountDialpad } from './dialpad.js';

const $ = (id) => document.getElementById(id);
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

/** One history row, as the phone list shows it. `onFabric` is a handle from number lookup. */
export function phoneItemLabel(e, { lineName = null } = {}) {
  const who = formatNumber(e.peer);
  let base;
  switch (e.kind) {
    case 'call': base = e.dir === 'out' ? `📞 Called ${who}` : `📞 Call from ${who}`; break;
    case 'missed': base = `📵 Missed call from ${who}`; break;
    case 'voicemail': base = `🎙 Voicemail from ${who} · ${e.seconds}s`; break;
    case 'sms': base = e.dir === 'out' ? `💬 To ${who}: ${e.text}` : `💬 From ${who}: ${e.text}`; break;
    default: base = who;
  }
  const withLine = e.via ? `${base} · on ${lineName || `burner ${formatNumber(e.via)}`}` : base;
  return e.onFabric ? `${withLine} · on FabriC++` : withLine;
}

const time = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * @param {object} o
 * @param {(msg: object) => Promise<object>} o.request  request/response over the relay socket
 * @param {() => boolean} o.inCall  a FABRIC call is active (then phone calls are refused)
 * @param {{ get: () => { records: object[], byPeer: object }, save: () => void }} [o.vault]
 *   where burner records (shared/burner.js) and each conversation's number live: the encrypted vault
 */
export function createPhone({ request, inCall = () => false, vault = null, openEvent = null, openAudio = null, accountKey = () => null, handle = () => null }) {
  const local = { records: [], byPeer: {} };
  const book = () => { const b = vault?.get() || local; b.records ??= []; b.byPeer ??= {}; return b; };
  const save = () => vault?.save();
  let status = null;     // { enabled, number, countries }
  let device = null;     // Twilio.Device
  let tokenTimer = null;
  let active = null;     // Twilio Call
  let incoming = null;   // Twilio Call ringing here
  let callInfo = null;   // { who, dir, since }
  const events = new Map(); // seq → event

  // ---------- which number ----------
  const activeBurners = () => book().records.filter((r) => r.state === 'active' && r.network === 'pstn');
  const recordOf = (number) => book().records.find((r) => r.state === 'active' && r.number === number);
  const nameOf = (r) => (r.label ? `${r.label} (${formatNumber(r.number)})` : `Burner ${formatNumber(r.number)}`);
  /** The number a conversation uses: null is your main number. */
  function lineOf(peer) {
    const choice = book().byPeer[peer];
    if (choice === 'main' && status?.number) return null;
    const r = lineFor(book().records, book().byPeer, peer);
    if (r) return r.number;
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
    $('phone-call-pad').classList.add('hidden');
    $('phone-keypad').setAttribute('aria-expanded', 'false');
    $('phone-call-tones').textContent = '';
    $('phone-call-tones').classList.add('hidden');
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
      const opened = await reveal(r.event);
      if (opened) {
        events.set(opened.seq, opened);
        noteFabric([opened]);
      }
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
      let mime = r.mime || 'audio/mpeg';
      let audioB64 = r.audio;
      if (r.box) {
        if (typeof openAudio !== 'function') throw new Error('this device cannot open voicemail');
        const opened = await openAudio({ box: r.box, seq });
        audioB64 = opened.audio;
        mime = opened.mime || mime;
      }
      if (!audioB64) throw new Error('recording unavailable');
      const bytes = Uint8Array.from(atob(audioB64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
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

  /** A sealed row becomes the event the list shows. An old relay's plaintext row is used as-is. */
  async function reveal(e) {
    if (!e) return null;
    if (!e.box) return e.kind ? e : null;
    if (typeof openEvent !== 'function') return null;
    try {
      const opened = await openEvent(e);
      if (!opened || typeof opened !== 'object') return null;
      return { ...opened, seq: e.seq, at: opened.at || e.at, via: opened.via || e.via };
    } catch {
      return null;
    }
  }

  /** Marks numbers the owner made discoverable. Uses the numbers already in this history, not a contact upload. */
  function noteFabric(list) {
    const numbers = [...new Set(list.map((e) => e.peer).filter((p) => p && p !== 'unknown' && E164.test(p)))].slice(0, 50);
    if (!numbers.length) return;
    request({ type: 'number_lookup', numbers }).then((r) => {
      let changed = false;
      for (const e of list) {
        const h = r.results?.[e.peer];
        if (h && e.onFabric !== h) { e.onFabric = h; changed = true; }
      }
      if (changed) renderLog();
    }).catch(() => {});
  }

  async function onEvent(e) {
    const opened = await reveal(e);
    if (!opened) return;
    e = opened;
    events.set(e.seq, e);
    // someone reached you on a burner: answering them uses that burner too
    if (e.dir === 'in' && e.via && e.peer && e.peer !== 'unknown' && !book().byPeer[e.peer]) {
      const r = recordOf(e.via);
      if (r) { book().byPeer[e.peer] = r.id; save(); renderFrom(); }
    }
    renderLog();
    noteFabric([e]);
    if (e.kind === 'sms' && e.dir === 'in') note(`New text from ${formatNumber(e.peer)}`);
    if (e.kind === 'voicemail') note(`New voicemail from ${formatNumber(e.peer)}`);
  }

  async function refreshLog() {
    try {
      const r = await request({ type: 'phone_log' });
      const list = [];
      for (const e of r.events || []) {
        const opened = await reveal(e);
        if (opened) list.push(opened);
      }
      events.clear();
      for (const e of list) events.set(e.seq, e);
      renderLog();
      noteFabric(list);
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
      : 'Ask the relay operator to assign you one of their numbers.';
    for (const id of ['phone-call', 'phone-sms']) $(id).disabled = !canPhone();
    renderFrom();
    renderBurners();
  }

  // ---------- burner numbers: burn all, emergency burn code ----------
  function renderBurners() {
    const b = status?.burners;
    $('burner-card').classList.toggle('hidden', !b);
    if (!b) return;
    const n = b.lines.length;
    $('burner-summary').textContent = n ? `${n} burner number${n === 1 ? '' : 's'} on this account.` : 'No burner numbers right now.';
    $('burner-burn-all').disabled = !n;
    const primary = Boolean(accountKey());
    $('burner-code').classList.toggle('hidden', !primary);
    $('burner-code').textContent = b.burnCode ? 'Make a new emergency burn code' : 'Make an emergency burn code';
    $('burner-code-off').classList.toggle('hidden', !primary || !b.burnCode);
    if (!primary) $('burner-code-note').textContent = b.burnCode ? 'An emergency burn code is set. Only the primary device can change it.' : 'Only the primary device can make an emergency burn code.';
  }

  async function burnAll() {
    const n = status?.burners?.lines.length || 0;
    if (!n || !confirm(`Burn all ${n} burner number${n === 1 ? '' : 's'}? They stop working at once, their calls and texts are deleted from the relay, and you can't get them back.`)) return;
    $('burner-burn-all').disabled = true;
    try {
      const r = await request({ type: 'burner_burn_all' });
      onStatus(r);
      $('burner-code-note').textContent = `Burned ${r.burned} number${r.burned === 1 ? '' : 's'}.`;
    } catch (e) {
      $('burner-code-note').textContent = `Could not burn them: ${e.message}`;
      renderBurners();
    }
  }

  async function setCode(on) {
    const key = accountKey();
    if (!key) return;
    const code = on ? newBurnCode() : null;
    try {
      const signed = await signBurnCode(key, { handle: handle(), hash: on ? await burnCodeHash(code) : '' });
      onStatus(await request({ type: 'burner_code_set', ...signed }));
      $('burner-code-show').classList.toggle('hidden', !on);
      $('burner-code-text').textContent = code || '';
      $('burner-code-note').textContent = on
        ? 'Write this code down and keep it away from this phone. It is shown only once, works once, and replaces any earlier code. With your handle, it burns every burner number at /burn.html.'
        : 'The emergency burn code is off.';
    } catch (e) {
      $('burner-code-note').textContent = `Could not save the code: ${e.message}`;
    }
  }

  // ---------- which number a conversation uses ----------
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
    renderFrom();
  }

  function label(e) {
    const r = e.via && recordOf(e.via);
    return phoneItemLabel(e, { lineName: r ? nameOf(r) : null });
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
  $('phone-sms').onclick = () => sendText($('phone-to').value, $('phone-text').value);
  $('burner-burn-all').onclick = () => burnAll();
  $('burner-code').onclick = () => setCode(true);
  $('burner-code-off').onclick = () => setCode(false);
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
  // touch-tones during a call: the on-screen pad sends each key as it's pressed
  mountDialpad($('phone-call-pad'), {
    onKey: (k) => {
      if (!active || !/^[0-9*#]$/.test(k)) return;
      active.sendDigits(k);
      const t = $('phone-call-tones');
      t.textContent = (t.textContent + k).slice(-24);
      t.classList.remove('hidden');
    },
  });
  $('phone-keypad').onclick = () => {
    const open = $('phone-call-pad').classList.toggle('hidden') === false;
    $('phone-keypad').setAttribute('aria-expanded', String(open));
  };
  mountDialpad($('phone-pad'), { input: $('phone-to') });
  addEventListener('pagehide', () => {
    active?.disconnect();
    device?.destroy();
  });

  return {
    refresh, onStatus, onEvent, dial,
    get status() { return status; },
    get busy() { return Boolean(active || incoming); },
  };
}
