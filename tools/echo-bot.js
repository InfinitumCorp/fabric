#!/usr/bin/env node
// A sample FabriC++ bot: echoes what you send and shows commands, inline buttons with callbacks,
// a reply keyboard and deep-link start parameters. Plain Node (22+), no dependencies.
//
//   1. In FabriC++, text +forgebot: /newbot, pick a name and an address ending in "bot".
//   2. FABRIC_BOT_TOKEN=<token> FABRIC_RELAY=http://localhost:8795 node tools/echo-bot.js
//
// It uses long polling (getUpdates). See the README's Bot API section for webhooks.

const TOKEN = process.env.FABRIC_BOT_TOKEN;
const RELAY = (process.env.FABRIC_RELAY || 'http://localhost:8787').replace(/\/$/, '');
if (!TOKEN) {
  console.error('Set FABRIC_BOT_TOKEN to the token +forgebot gave you.');
  process.exit(1);
}

async function call(method, body = {}) {
  const res = await fetch(`${RELAY}/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!out.ok) {
    const err = new Error(`${method}: ${out.description}`);
    err.retryAfter = out.parameters?.retry_after;
    throw err;
  }
  return out.result;
}

const counters = new Map(); // message_id -> count, for the counter buttons

const counterMarkup = (n) => ({
  inline_keyboard: [
    [{ text: '−1', callback_data: 'dec' }, { text: `${n}`, callback_data: 'show' }, { text: '+1', callback_data: 'inc' }],
    [{ text: 'Done', callback_data: 'done' }, { text: 'FabriC++ on the web', url: 'https://github.com/InfinitumCorp/fabric' }],
  ],
});

async function onMessage(m) {
  const chat = m.chat.id;
  const text = m.text || '';
  const [cmd] = text.trim().split(/\s/);
  const command = cmd.startsWith('/') ? cmd.slice(1).split('@')[0].toLowerCase() : null;

  if (command === 'start') {
    const hello = m.start_param ? `Hello! You came from the link "${m.start_param}".` : 'Hello! I repeat what you send.';
    return call('sendMessage', { chat_id: chat, text: `${hello}\nTry /buttons, /keyboard or /help.` });
  }
  if (command === 'help') {
    return call('sendMessage', { chat_id: chat, text: 'I echo text and files.\n/buttons: a counter with inline buttons\n/keyboard: a reply keyboard\n/hide: hide the keyboard' });
  }
  if (command === 'buttons') {
    const sent = await call('sendMessage', { chat_id: chat, text: 'Counter: 0', reply_markup: counterMarkup(0) });
    counters.set(sent.message_id, 0);
    return sent;
  }
  if (command === 'keyboard') {
    return call('sendMessage', {
      chat_id: chat, text: 'How are you?',
      reply_markup: { keyboard: [['Great', 'Fine'], ['Not so good']], resize_keyboard: true, one_time_keyboard: true, input_field_placeholder: 'Pick an answer' },
    });
  }
  if (command === 'hide') return call('sendMessage', { chat_id: chat, text: 'Keyboard hidden.', reply_markup: { remove_keyboard: true } });
  if (m.media) {
    const field = { image: 'photo', audio: 'audio', file: 'document' }[m.media.type];
    const method = { image: 'sendPhoto', audio: 'sendAudio', file: 'sendDocument' }[m.media.type];
    return call(method, { chat_id: chat, [field]: m.media.data, mime_type: m.media.mime, file_name: m.media.name, caption: text ? `You sent: ${text}` : '' });
  }
  if (command) return call('sendMessage', { chat_id: chat, text: `I don't know /${command}. Try /help.` });
  return call('sendMessage', { chat_id: chat, text, reply_to_message_id: m.message_id, reply_to_text: text, reply_to_from: m.from.id });
}

async function onCallback(q) {
  const id = q.message.message_id;
  const chat = q.message.chat.id;
  let n = counters.get(id) ?? 0;
  if (q.data === 'show') return call('answerCallbackQuery', { callback_query_id: q.id, text: `The counter is ${n}`, show_alert: true });
  if (q.data === 'done') {
    await call('answerCallbackQuery', { callback_query_id: q.id, text: 'Saved' });
    counters.delete(id);
    return call('editMessageText', { chat_id: chat, message_id: id, text: `Counter finished at ${n}.` });
  }
  n += q.data === 'inc' ? 1 : -1;
  counters.set(id, n);
  await call('answerCallbackQuery', { callback_query_id: q.id });
  return call('editMessageText', { chat_id: chat, message_id: id, text: `Counter: ${n}`, reply_markup: counterMarkup(n) });
}

async function main() {
  const me = await call('getMe');
  await call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Say hello' },
      { command: 'buttons', description: 'A counter with inline buttons' },
      { command: 'keyboard', description: 'Show a reply keyboard' },
      { command: 'hide', description: 'Hide the keyboard' },
      { command: 'help', description: 'What I can do' },
    ],
  });
  await call('setMyDescription', { description: 'A sample bot: echoes your messages and shows buttons and commands.' });
  console.log(`${me.name} (${me.handle}) is running against ${RELAY}. Ctrl+C to stop.`);
  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await call('getUpdates', { offset, timeout: 30 });
    } catch (e) {
      console.error(e.message);
      await new Promise((r) => setTimeout(r, (e.retryAfter || 3) * 1000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      try {
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      } catch (e) {
        console.error(e.message);
      }
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
