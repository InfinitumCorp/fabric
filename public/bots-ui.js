// Bots in the web client (and so in the Android and desktop apps, which load it): the bot notice
// and Start button, inline buttons under bot messages and their callbacks, reply keyboards over the
// composer, the / command menu, bot profiles, and fabric://bot/<name>?start=<param> deep links.
//
// Everything a bot sends still arrives end-to-end encrypted to this device; what changes is who can
// read the other end. A bot's device runs on the relay, so the relay and the bot's developer can read
// what you send it. The notice says that in every bot chat.

import { markupOf, answerOf, isBotHandle, parseBotLink, FORGE_HANDLE } from '/shared/bots.js';

const INFO_TTL_MS = 10 * 60_000;
const rid = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);

export function installBots(x) {
  const { $, el, toast } = x;
  const infos = new Map(); // handle -> { at, info }
  const pressing = new Map(); // qid -> { at, button }
  let pendingLink = null; // { handle, start } waiting for sign-in
  const dismissedKb = new Set(); // message ids whose one-time keyboard was used

  // ---------- profiles ----------
  function cached(h) {
    const c = infos.get(h);
    return c && Date.now() - c.at < INFO_TTL_MS ? c.info : null;
  }
  async function infoOf(h) {
    const c = cached(h);
    if (c) return c;
    if (!isBotHandle(h) && h !== '@scalvs.veil') return { bot: false };
    try {
      const info = await (await fetch(`/api/bots/info?handle=${encodeURIComponent(h)}`)).json();
      infos.set(h, { at: Date.now(), info });
      return info;
    } catch {
      const info = { bot: false };
      infos.set(h, { at: Date.now(), info }); // don't ask again on every render
      return info;
    }
  }
  const isBot = (h) => Boolean(cached(h)?.bot);
  const botsIn = (key) => {
    if (!x.isGroupKey(key)) return isBot(key) ? [key] : [];
    return (x.groupFor(key)?.members || []).filter(isBot);
  };

  // ---------- messages ----------
  /** Markup on a received text message (only bots' markup is kept). */
  function markupFor(from, payload) {
    if (!isBotHandle(from) && from !== '@scalvs.veil') return null;
    return markupOf(payload);
  }

  /** An edit from a bot may replace or clear its buttons. */
  function applyEditMarkup(m, payload) {
    if (!('markup' in payload) || !isBotHandle(m.from)) return;
    const mk = payload.markup === null ? null : markupOf(payload);
    if (mk?.inline) m.markup = mk; else delete m.markup;
  }

  function onAnswer(from, payload) {
    const a = answerOf(payload);
    if (!a || !pressing.has(a.qid)) return;
    const p = pressing.get(a.qid);
    pressing.delete(a.qid);
    p.button?.classList.remove('pressing');
    if (!a.text) return;
    // translated on this device like the bot's messages, when translation is on in that chat
    const show = (text) => { if (a.alert) showAlert(from, text); else toast(text); };
    if (!x.translateAnswer) return show(a.text);
    x.translateAnswer(from, a.text).then((t) => show(t || a.text), () => show(a.text));
  }

  function showAlert(from, text) {
    const box = el('div', 'bot-alert');
    box.setAttribute('role', 'alertdialog');
    const card = el('div', 'bot-alert-card');
    const ok = el('button', 'primary', 'OK');
    ok.type = 'button';
    ok.onclick = () => box.remove();
    card.append(el('div', 'eyebrow', `+${from.slice(1)}`), el('p', '', text), ok);
    box.append(card);
    box.onclick = (e) => { if (e.target === box) box.remove(); };
    document.body.append(box);
    ok.focus();
  }

  async function press(key, m, b, button) {
    if (b.url) {
      if (confirm(`Open this link in your browser?\n\n${b.url}`)) window.open(b.url, '_blank', 'noopener');
      return;
    }
    const qid = rid();
    pressing.set(qid, { at: Date.now(), button });
    button.classList.add('pressing');
    setTimeout(() => { if (pressing.delete(qid)) button.classList.remove('pressing'); }, 15_000);
    try {
      await x.sendControl(key, { kind: 'bot_cb', qid, target: m.id, data: b.data }, { only: m.from, self: false, outbox: false });
    } catch {
      pressing.delete(qid);
      button.classList.remove('pressing');
      toast('Could not reach the bot');
    }
  }

  /** Inline buttons under a bot's message. */
  function decorate(li, m, key) {
    if (!m.markup?.inline || m.deleted || m.from === x.db().handle) return;
    const grid = el('div', 'bot-buttons');
    for (const row of m.markup.inline) {
      const r = el('div', 'bot-row');
      for (const b of row) {
        const btn = el('button', 'bot-btn' + (b.url ? ' link' : ''), b.text);
        btn.type = 'button';
        if (b.url) btn.title = b.url;
        btn.onclick = (e) => { e.stopPropagation(); press(key, m, b, btn); };
        r.append(btn);
      }
      grid.append(r);
    }
    li.append(grid);
    li.classList.add('has-buttons');
  }

  // ---------- the chat: notice, Start, reply keyboard, command menu ----------
  function latestKeyboard(key) {
    const t = x.db().threads[key] || [];
    for (let i = t.length - 1; i >= 0; i--) {
      const m = t[i];
      if (m.from === x.db().handle || !m.markup) continue;
      if (m.markup.remove) return null;
      if (m.markup.keyboard) return dismissedKb.has(m.id) || m.kbUsed ? null : m;
    }
    return null;
  }

  function startText(key) {
    const link = pendingLink?.handle === key ? pendingLink : null;
    return link?.start ? `/start ${link.start}` : '/start';
  }

  async function renderThread(key) {
    const ol = $('messages');
    const panel = ensurePanel();
    panel.replaceChildren();
    panel.classList.add('hidden');
    $('bot-cmd-btn')?.classList.add('hidden');
    hideMenu();
    if (!key || key === x.SAVED) return;
    const handles = x.isGroupKey(key) ? (x.groupFor(key)?.members || []) : [key];
    const unknown = handles.filter((h) => (isBotHandle(h) || h === '@scalvs.veil') && !cached(h));
    if (unknown.length) { await Promise.all(unknown.map(infoOf)); if (x.active() === key) { x.renderThreadHead(); x.renderMessages(); } return; }
    const bots = botsIn(key);
    if (!bots.length) return;
    $('bot-cmd-btn')?.classList.toggle('hidden', !bots.some((h) => cached(h)?.commands?.length));

    if (!x.isGroupKey(key)) {
      const info = cached(key);
      const t = x.db().threads[key] || [];
      const notice = el('li', 'bot-notice');
      notice.append(el('div', 'eyebrow', info.system ? 'FabriC++ system bot' : 'Bot'));
      if (info.about) notice.append(el('p', 'bot-about', info.about));
      notice.append(el('p', 'muted small', info.system
        ? 'Messages to this bot are end-to-end encrypted to it. It runs on the relay, so the relay operator can read them.'
        : 'Messages to this bot are end-to-end encrypted to it. It runs on the relay for its developer, so the relay operator and the bot\'s developer can read what you send it. Don\'t send it anything you want kept private.'));
      const wrote = t.some((m) => m.from === x.db().handle);
      if (!wrote || (pendingLink?.handle === key && pendingLink.start)) {
        const start = el('button', 'primary bot-start', pendingLink?.handle === key && pendingLink.start ? `Start (${pendingLink.start})` : 'Start');
        start.type = 'button';
        start.onclick = () => { const text = startText(key); pendingLink = null; x.sendText(text, null, {}, key); };
        notice.append(start);
      }
      ol.prepend(notice);
    } else {
      const sys = el('li', 'sysline', `${bots.map((h) => `+${h.slice(1)}`).join(', ')} ${bots.length > 1 ? 'are bots' : 'is a bot'} in this group. ${bots.length > 1 ? 'Their operators' : 'Its operator'} can read the messages ${bots.length > 1 ? 'they receive' : 'it receives'}.`);
      ol.prepend(sys);
    }

    const kb = latestKeyboard(key);
    if (kb) {
      for (const row of kb.markup.keyboard) {
        const r = el('div', 'bot-row');
        for (const b of row) {
          const btn = el('button', 'bot-key', b.text);
          btn.type = 'button';
          btn.onclick = () => {
            if (kb.markup.once) { kb.kbUsed = true; dismissedKb.add(kb.id); x.persist(); }
            x.sendText(b.text, null, {}, key);
          };
          r.append(btn);
        }
        panel.append(r);
      }
      panel.classList.toggle('compact', kb.markup.resize === true);
      panel.classList.remove('hidden');
      if (kb.markup.placeholder) $('text').placeholder = kb.markup.placeholder;
    } else $('text').placeholder = 'Message';
  }

  function ensurePanel() {
    let p = $('bot-keyboard');
    if (!p) {
      p = el('div', 'bot-keyboard hidden');
      p.id = 'bot-keyboard';
      $('composer').before(p);
    }
    if (!$('bot-cmd-btn')) {
      const b = el('button', 'icon-btn bot-cmd-btn hidden', '/');
      b.id = 'bot-cmd-btn';
      b.type = 'button';
      b.title = 'Bot commands';
      b.setAttribute('aria-label', 'Bot commands');
      b.onclick = (e) => { e.stopPropagation(); toggleMenu(''); };
      $('text').before(b);
    }
    return p;
  }

  // command menu: the / button, or typing / at the start of the message
  function commandsHere() {
    const key = x.active();
    const bots = botsIn(key);
    const out = [];
    for (const h of bots) for (const c of cached(h)?.commands || []) out.push({ ...c, bot: h, multi: bots.length > 1 });
    return out;
  }
  function hideMenu() { $('bot-menu')?.remove(); }
  function toggleMenu(filter) {
    const open = $('bot-menu');
    if (open && filter === '') return hideMenu();
    const list = commandsHere().filter((c) => c.command.startsWith(filter.toLowerCase()));
    hideMenu();
    if (!list.length) return;
    const menu = el('div', 'bot-menu');
    menu.id = 'bot-menu';
    menu.setAttribute('role', 'listbox');
    for (const c of list.slice(0, 20)) {
      const item = el('button', 'bot-menu-item');
      item.type = 'button';
      const name = c.multi ? `/${c.command}@${c.bot.slice(1, -5)}` : `/${c.command}`;
      item.append(el('strong', '', name), el('span', 'muted small', c.description));
      item.onclick = () => { hideMenu(); $('text').value = ''; x.sendText(name, null, {}, x.active()); };
      menu.append(item);
    }
    $('composer').before(menu);
  }
  function onInput() {
    const v = $('text').value;
    if (/^\/[a-z0-9_]*$/i.test(v) && commandsHere().length) toggleMenu(v.slice(1)); else hideMenu();
  }

  // ---------- profile (thread head) ----------
  function headLabel(key) {
    const info = cached(key);
    if (!info?.bot) return null;
    return info.system ? 'system bot · its operator can read what you send' : 'bot · its operator can read what you send';
  }
  function showProfile(key) {
    const info = cached(key);
    if (!info?.bot) return false;
    const lines = [`${info.name || key} · +${key.slice(1)}`, info.about || '', info.commands?.length ? `Commands:\n${info.commands.map((c) => `/${c.command} – ${c.description}`).join('\n')}` : '',
      info.privacy === false ? 'In groups it reads every message.' : 'In groups it only reads commands, mentions and replies to it.',
      'Messages to it are readable by the relay operator and the bot\'s developer.'];
    showAlert(key, lines.filter(Boolean).join('\n\n'));
    return true;
  }

  // ---------- deep links ----------
  /** fabric://bot/<name>?start=x, or this page with ?bot=<name>&start=x: open that bot's chat. */
  function openLink(href) {
    const link = parseBotLink(href);
    if (!link) return false;
    pendingLink = link;
    if (x.signedIn()) go();
    return true;
  }
  function go() {
    if (!pendingLink) return;
    x.addContact(pendingLink.handle).catch((e) => toast(e.message));
  }
  function onSignedIn() { go(); }

  // links typed or clicked inside messages
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="fabric:"]');
    if (!a) return;
    e.preventDefault();
    openLink(a.href);
  });
  // the Android and desktop shells hand deep links to the page this way
  window.fabricOpenLink = (href) => openLink(href);
  if (new URLSearchParams(location.search).get('bot')) openLink(location.href);
  $('text').addEventListener('input', onInput);
  $('peer').addEventListener('click', () => showProfile(x.active()));
  $('bots-settings')?.addEventListener('click', () => { x.addContact(FORGE_HANDLE).catch((e) => toast(e.message)); });

  return { markupFor, applyEditMarkup, onAnswer, decorate, renderThread, headLabel, showProfile, openLink, onSignedIn, isBot, infoOf, FORGE_HANDLE };
}
