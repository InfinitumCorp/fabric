// +forgebot.veil: the system bot that makes bots. Text it /newbot, pick a name and an address
// ending in "bot", and it replies with the bot's token for the Bot API (server/bots.js).
// /mybots lists your bots with buttons to replace the token, set commands, the description and
// privacy mode, or delete the bot.
//
// Forge is itself a bot device (server/bot-device.js) that the relay runs: what you send it is
// end-to-end encrypted to it, and it answers in the same encrypted chat. Tokens are sent only to the
// person who owns the bot, in that chat.

import { createBotDevice } from './bot-device.js';
import { callbackOf, parseCommand, FORGE_HANDLE } from '../shared/bots.js';
import { Buckets } from './limits.js';

const STEP_TTL_MS = 15 * 60_000;

export function createForge({ hub, state, save, log = console.log, now = Date.now }) {
  const steps = new Map(); // owner -> { step, data, at }
  const limit = new Buckets(20, 20 / 60, { now });
  let device = null;

  const profile = {
    name: 'Forge',
    about: 'Makes and manages FabriC++ bots. Send /newbot to create one and get its Bot API token.',
    commands: [
      { command: 'newbot', description: 'Create a new bot' },
      { command: 'mybots', description: 'Your bots: token, commands, description, privacy, delete' },
      { command: 'help', description: 'How bots work' },
      { command: 'cancel', description: 'Stop what you were doing' },
    ],
    privacy: true,
  };

  const say = (to, text, markup = null) => device.send(to, { kind: 'text', text, ...(markup ? { markup } : {}) })
    .catch((e) => log(`[forge] reply failed: ${e.message}`));
  const edit = (to, target, text, markup = null) => device.send(to, { kind: 'action', act: 'edit', target, text, markup })
    .catch((e) => log(`[forge] edit failed: ${e.message}`));
  const plus = (h) => `+${h.slice(1)}`;
  const toHandle = (s) => `@${String(s || '').trim().toLowerCase().replace(/^[+@]/, '').replace(/\.veil$/, '')}.veil`;

  const HELP = [
    'I make bots for FabriC++.',
    '',
    '/newbot: create a bot and get its token',
    '/mybots: manage your bots',
    '',
    'Your program uses the token with the Bot API on this relay: POST /bot<token>/sendMessage, getUpdates (long polling) or setWebhook. The README on the FabriC++ repository documents every method.',
    '',
    'Bots run on the relay: messages people send a bot are end-to-end encrypted to the bot, and then readable by the relay and by the bot\'s developer. FabriC++ shows people that before they write to a bot.',
  ].join('\n');

  const home = { inline: [[{ text: 'New bot', data: 'new' }, { text: 'My bots', data: 'list' }]] };

  function botMenu(h) {
    const b = hub.get(h);
    const text = [
      `${b.name} · ${plus(h)}`,
      b.about ? `\n${b.about}` : '',
      `\nCommands: ${b.commands.length ? b.commands.map((c) => `/${c.command}`).join(' ') : 'none'}`,
      `Privacy mode: ${b.privacy ? 'on (in groups it only sees commands, mentions and replies to it)' : 'off (it sees every group message)'}`,
      `Updates: ${b.webhook ? 'webhook' : 'long polling'}`,
    ].join('\n');
    const markup = { inline: [
      [{ text: 'Replace token', data: `tok:${h}` }, { text: 'Commands', data: `cmd:${h}` }],
      [{ text: 'Description', data: `abt:${h}` }, { text: `Privacy ${b.privacy ? 'off' : 'on'}`, data: `prv:${h}` }],
      [{ text: 'Delete bot', data: `del:${h}` }, { text: 'Back', data: 'list' }],
    ] };
    return { text, markup };
  }

  function listView(owner) {
    const mine = hub.ownedBy(owner);
    if (!mine.length) return { text: 'You have no bots yet.', markup: { inline: [[{ text: 'New bot', data: 'new' }]] } };
    const rows = [];
    for (let i = 0; i < mine.length; i += 2) rows.push(mine.slice(i, i + 2).map((b) => ({ text: plus(b.handle), data: `bot:${b.handle}` })));
    return { text: `Your bots (${mine.length}). Pick one:`, markup: { inline: rows.slice(0, 8) } };
  }

  const tokenText = (h, token) => [
    `Done. ${plus(h)} is ready. Its token:`,
    '',
    token,
    '',
    'Keep the token secret: anyone who has it controls the bot. Try it:',
    `curl ${'<relay>'}/bot${token}/getMe`,
  ].join('\n');

  async function onText(from, text) {
    const cmd = parseCommand(text);
    const s = steps.get(from);
    const active = s && now() - s.at < STEP_TTL_MS ? s : null;
    if (cmd) steps.delete(from);
    if (cmd?.command === 'start' || cmd?.command === 'help') return say(from, HELP, home);
    if (cmd?.command === 'cancel') return say(from, active ? 'OK, stopped.' : 'Nothing to stop.');
    if (cmd?.command === 'newbot') { steps.set(from, { step: 'name', at: now() }); return say(from, 'What should your bot be called? This is the name people see (up to 40 characters).'); }
    if (cmd?.command === 'mybots') { const v = listView(from); return say(from, v.text, v.markup); }
    if (cmd) return say(from, `I don't know /${cmd.command}. Send /help.`);
    if (!active) return say(from, HELP, home);

    if (active.step === 'name') {
      const name = text.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
      if (!name) return say(from, 'Send a name for the bot.');
      steps.set(from, { step: 'handle', data: { name }, at: now() });
      return say(from, `Now an address. It must end in "bot", like +${name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 18) || 'my'}bot.`);
    }
    if (active.step === 'handle') {
      const h = toHandle(text);
      const why = hub.checkNewHandle(h);
      if (why) return say(from, why);
      try {
        const { token } = await hub.create(from, h, active.data.name);
        steps.delete(from);
        return say(from, tokenText(h, token), { inline: [[{ text: 'Manage this bot', data: `bot:${h}` }]] });
      } catch (e) { return say(from, e.message); }
    }
    const b = active.data?.handle && hub.get(active.data.handle);
    if (!b || b.owner !== from) { steps.delete(from); return say(from, 'That bot is gone.'); }
    if (active.step === 'commands') {
      const list = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = /^\/?([A-Za-z0-9_]+)\s*[-–—:]\s*(.+)$/.exec(l);
        return m ? { command: m[1].toLowerCase(), description: m[2] } : { command: l, description: '' };
      });
      try { hub.update(b.handle, { commands: text.trim() === '/empty' ? [] : list }); } catch (e) { return say(from, `${e.message}. Send one per line: command - description`); }
      steps.delete(from);
      const v = botMenu(b.handle);
      return say(from, `Commands saved.\n\n${v.text}`, v.markup);
    }
    if (active.step === 'about') {
      hub.update(b.handle, { about: text.trim() === '/empty' ? '' : text });
      steps.delete(from);
      const v = botMenu(b.handle);
      return say(from, `Description saved.\n\n${v.text}`, v.markup);
    }
    return undefined;
  }

  async function onCallback(from, cb) {
    const answer = (text = '', alert = false) => device.send(from, { kind: 'bot_answer', qid: cb.qid, ...(text ? { text } : {}), ...(alert ? { alert: true } : {}) }).catch(() => {});
    const [op, h] = cb.data.split(/:(.*)/s);
    if (op === 'new') { steps.set(from, { step: 'name', at: now() }); await answer(); return say(from, 'What should your bot be called?'); }
    if (op === 'list') { const v = listView(from); await answer(); return edit(from, cb.target, v.text, v.markup); }
    const b = h && hub.get(h);
    if (!b || b.owner !== from) return answer('That bot is not yours or no longer exists.', true);
    if (op === 'bot') { const v = botMenu(h); await answer(); return edit(from, cb.target, v.text, v.markup); }
    if (op === 'tok') {
      const token = hub.rotate(h);
      await answer('Token replaced. The old one stops working now.');
      return say(from, `New token for ${plus(h)}:\n\n${token}`);
    }
    if (op === 'cmd') {
      steps.set(from, { step: 'commands', data: { handle: h }, at: now() });
      await answer();
      return say(from, `Send the commands for ${plus(h)}, one per line:\n\nstart - Say hello\nhelp - What I can do\n\nor /empty to clear them.`);
    }
    if (op === 'abt') {
      steps.set(from, { step: 'about', data: { handle: h }, at: now() });
      await answer();
      return say(from, `Send the description people see on ${plus(h)}'s profile (up to 512 characters), or /empty.`);
    }
    if (op === 'prv') {
      hub.update(h, { privacy: !b.privacy });
      const v = botMenu(h);
      await answer(`Privacy mode ${b.privacy ? 'on' : 'off'}`);
      return edit(from, cb.target, v.text, v.markup);
    }
    if (op === 'del') {
      await answer();
      return edit(from, cb.target, `Delete ${plus(h)}? Its token stops working and the address is retired for good.`, {
        inline: [[{ text: 'Yes, delete', data: `rm:${h}` }, { text: 'No', data: `bot:${h}` }]],
      });
    }
    if (op === 'rm') {
      hub.remove(h);
      await answer('Deleted');
      return edit(from, cb.target, `${plus(h)} was deleted.`, { inline: [[{ text: 'My bots', data: 'list' }]] });
    }
    return answer();
  }

  async function onMessage({ from, payload }) {
    if (payload?.group || payload?.gid !== undefined) return; // Forge works in direct chats only
    const cb = callbackOf(payload);
    if (!cb && payload?.kind !== 'text') return;
    if (limit.take(from)) return cb ? undefined : say(from, 'Slow down a little, then try again.');
    if (cb) return onCallback(from, cb);
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text.trim()) return say(from, 'I read text. Send /help.');
    return onText(from, text);
  }

  device = createBotDevice({ state, save, onMessage, log, now, tag: 'forge' });
  return { device, profile, accountKey: state.account.publicJwk, handle: FORGE_HANDLE };
}
