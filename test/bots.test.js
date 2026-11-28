import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createRelay } from '../server/relay.js';
import { isPrivateAddress } from '../server/bots.js';
import {
  markupOf, markupFromApi, parseCommand, concernsBot, parseBotLink, commandsFrom, callbackOf, FORGE_HANDLE, isBotHandle,
} from '../shared/bots.js';
import { generateUserIdentity, generateSigningKey, ownershipProof, newMessageId } from '../shared/crypto.js';
import { SessionManager, emptyStore } from '../shared/session.js';
import { signDeviceList, newDeviceId, deviceAddr, findDevice } from '../shared/devices.js';

// ---------- shared rules ----------
test('markup: inline buttons, reply keyboards and removal are checked and malformed ones dropped', () => {
  assert.deepEqual(markupOf({ markup: { inline: [[{ text: 'A', data: 'a' }, { text: 'Site', url: 'https://x.test/' }]] } }),
    { inline: [[{ text: 'A', data: 'a' }, { text: 'Site', url: 'https://x.test/' }]] });
  assert.equal(markupOf({ markup: { inline: [[{ text: 'X', url: 'javascript:alert(1)' }]] } }), null, 'only http(s) links');
  assert.equal(markupOf({ markup: { inline: [[{ text: 'X', data: 'x'.repeat(65) }]] } }), null, 'callback data up to 64 bytes');
  assert.equal(markupOf({ markup: { inline: Array(9).fill([{ text: 'a', data: 'a' }]) } }), null, 'up to 8 rows');
  assert.deepEqual(markupOf({ markup: { keyboard: [['Yes', { text: 'No' }]], once: true, placeholder: 'Pick' } }),
    { keyboard: [[{ text: 'Yes' }, { text: 'No' }]], once: true, placeholder: 'Pick' });
  assert.deepEqual(markupOf({ markup: { remove: true } }), { remove: true });
  assert.deepEqual(markupFromApi({ inline_keyboard: [[{ text: 'Go', callback_data: 'go' }]] }), { inline: [[{ text: 'Go', data: 'go' }]] });
  assert.deepEqual(markupFromApi('{"keyboard":[["a"]],"resize_keyboard":true}'), { keyboard: [[{ text: 'a' }]], resize: true });
  assert.throws(() => markupFromApi({ nope: 1 }), /inline_keyboard/);
});

test('commands, mentions, deep links, handles', () => {
  assert.deepEqual(parseCommand('/start ref42'), { command: 'start', target: null, args: 'ref42' });
  assert.deepEqual(parseCommand('/Help@echobot'), { command: 'help', target: '@echobot.veil', args: '' });
  assert.equal(parseCommand('hello /start'), null);
  assert.ok(concernsBot('/roll', '@dicebot.veil'));
  assert.ok(!concernsBot('/roll@otherbot', '@dicebot.veil'));
  assert.ok(concernsBot('hey +dicebot roll', '@dicebot.veil'));
  assert.ok(!concernsBot('hey +dicebotx', '@dicebot.veil'));
  assert.ok(concernsBot('ok', '@dicebot.veil', '@dicebot.veil'), 'a reply to the bot');
  assert.ok(!concernsBot('just chatting', '@dicebot.veil'));
  assert.deepEqual(parseBotLink('fabric://bot/echobot?start=abc'), { handle: '@echobot.veil', start: 'abc' });
  assert.deepEqual(parseBotLink('https://relay.test/?bot=%2Becho_bot&start=bad%20param'), { handle: '@echo_bot.veil', start: null });
  assert.equal(parseBotLink('fabric://bot/alice'), null, 'only bot addresses');
  assert.ok(isBotHandle(FORGE_HANDLE) && !isBotHandle('@alice.veil'));
  assert.throws(() => commandsFrom([{ command: 'Bad Cmd', description: 'x' }]), /a-z/);
  assert.deepEqual(commandsFrom([{ command: '/Start', description: 'Hi' }]), [{ command: 'start', description: 'Hi' }]);
  assert.equal(callbackOf({ kind: 'bot_cb', qid: 'short', target: 'abcdefgh12', data: 'x' }), null);
  for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '100.64.0.1']) assert.ok(isPrivateAddress(ip), ip);
  assert.ok(!isPrivateAddress('93.184.216.34'));
});

// ---------- end to end ----------
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  const next = (pred, ms = 8000) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); reject(new Error('timeout waiting for message')); } }, ms);
    });
  };
  let ref = 0;
  const send = (o) => ws.send(JSON.stringify(o));
  const ask = async (o, type) => {
    const r = String(++ref);
    send({ ...o, ref: r });
    const m = await next((x) => x.ref === r && (x.type === type || x.type === 'error'));
    if (m.type === 'error') throw new Error(m.error);
    return m;
  };
  return { ws, next, send, ask, close: () => ws.close() };
}

async function person(port, handle) {
  const acct = await generateSigningKey();
  const dev = { id: newDeviceId(), keys: await generateUserIdentity() };
  const list = await signDeviceList(acct.privateJwk, {
    handle, version: 1, account: acct.publicJwk,
    devices: [{ id: dev.id, name: 'Laptop', dh: dev.keys.dh.publicJwk, sig: dev.keys.sig.publicJwk, addedAt: 1 }],
  });
  const c = client(port);
  const hello = await c.next((m) => m.type === 'hello');
  c.send({ type: 'register', handle, deviceId: dev.id, list, proof: await ownershipProof(dev.keys.dh.privateJwk, hello.relayKey, hello.nonce) });
  const reg = await c.next((m) => m.type === 'registered' || m.type === 'error');
  if (reg.type === 'error') { c.close(); return { error: reg.error }; }
  const sm = new SessionManager({ handle, deviceId: dev.id, identity: dev.keys, store: emptyStore(), fetchBundle: async (addr) => (await c.ask({ type: 'bundle', addr }, 'bundle')).bundle });
  const count = await c.next((m) => m.type === 'prekey_count');
  const up = await sm.maintainPreKeys(count.count, { forceSpk: !count.hasSpk });
  if (up) { c.send({ type: 'upload_prekeys', ...up }); await c.next((m) => m.type === 'prekey_count'); }
  const lists = {};
  const listOf = async (h) => (lists[h] ??= (await c.ask({ type: 'lookup', handle: h }, 'directory')).list.payload);
  return {
    handle, c, sm,
    /** encrypt a payload to every device of `to` (a handle); returns the message id */
    async tell(to, payload, id = newMessageId()) {
      for (const d of (await listOf(to)).devices) {
        const env = await sm.encrypt(deviceAddr(to, d.id), payload, { id });
        c.send({ type: 'send', envelope: env });
        await c.next((m) => m.type === 'ack' && m.id === env.id);
      }
      return id;
    },
    /** next decrypted payload (skipping receipts/typing unless asked) */
    async hear(kinds = ['text', 'action', 'bot_answer', 'group']) {
      for (;;) {
        const { envelope } = await c.next((m) => m.type === 'deliver');
        const dev = findDevice(await listOf(envelope.from), envelope.fromDevice);
        const payload = await sm.decrypt(envelope, { dh: dev.dh, sig: dev.sig });
        c.send({ type: 'got', id: envelope.id });
        if (kinds.includes(payload.kind)) return { from: envelope.from, id: envelope.id, payload };
      }
    },
  };
}

test('bots end to end: make one with +forgebot, drive it over the Bot API', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, bots: { stateDir: null, allowLocalWebhooks: true } });
  t.after(() => relay.close());
  await relay.botsReady;
  const api = async (token, method, body = {}) => {
    const r = await fetch(`${relay.url}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };

  const amy = await person(relay.port, '@amy.veil');
  let token;
  const BOT = '@echotestbot.veil';

  await t.test('forge: /newbot, a name, an address -> a token, sent only in that chat', async () => {
    await amy.tell(FORGE_HANDLE, { kind: 'text', text: '/newbot' });
    assert.match((await amy.hear()).payload.text, /called/);
    await amy.tell(FORGE_HANDLE, { kind: 'text', text: 'Echo Test' });
    assert.match((await amy.hear()).payload.text, /end in "bot"/);
    await amy.tell(FORGE_HANDLE, { kind: 'text', text: '+helper' });
    assert.match((await amy.hear()).payload.text, /ends in "bot"/, 'refuses an address without "bot"');
    await amy.tell(FORGE_HANDLE, { kind: 'text', text: '+echotestbot' });
    const done = await amy.hear();
    token = /\n([A-Za-z0-9_-]{8}:[A-Za-z0-9_-]{32})\n/.exec(done.payload.text)?.[1];
    assert.ok(token, 'the reply carries the token');
    assert.equal(done.payload.markup.inline[0][0].data, `bot:${BOT}`);
    const me = await api(token, 'getMe');
    assert.equal(me.ok, true);
    assert.equal(me.result.id, BOT);
    assert.equal(me.result.name, 'Echo Test');
    assert.equal((await api('AAAAAAAA:' + 'A'.repeat(32), 'getMe')).error_code, 401);
    const info = await (await fetch(`${relay.url}/api/bots/info?handle=%2Becho_testbot`)).json();
    assert.deepEqual(info, { bot: false });
  });

  await t.test('a bot cannot write first; /start with a deep-link parameter arrives by long polling', async () => {
    const first = await api(token, 'sendMessage', { chat_id: amy.handle, text: 'hi' });
    assert.equal(first.error_code, 403);
    const poll = api(token, 'getUpdates', { timeout: 5 });
    await new Promise((r) => setTimeout(r, 100));
    await amy.tell(BOT, { kind: 'text', text: '/start promo7' });
    const ups = await poll;
    assert.equal(ups.ok, true);
    const m = ups.result[0].message;
    assert.equal(m.text, '/start promo7');
    assert.equal(m.start_param, 'promo7');
    assert.deepEqual(m.chat, { id: amy.handle, type: 'private' });
    assert.equal(m.entities[0].type, 'bot_command');
    const again = await api(token, 'getUpdates', { offset: ups.result[0].update_id + 1 });
    assert.deepEqual(again.result, [], 'confirmed updates are gone');
  });

  let sentId;
  await t.test('sendMessage with inline buttons; a press is a callback query; the answer reaches the presser', async () => {
    const r = await api(token, 'sendMessage', { chat_id: amy.handle, text: 'Pick one', reply_markup: { inline_keyboard: [[{ text: 'Red', callback_data: 'red' }, { text: 'Blue', callback_data: 'blue' }]] } });
    assert.equal(r.ok, true, JSON.stringify(r));
    sentId = r.result.message_id;
    const got = await amy.hear();
    assert.equal(got.from, BOT);
    assert.equal(got.payload.text, 'Pick one');
    assert.deepEqual(got.payload.markup, { inline: [[{ text: 'Red', data: 'red' }, { text: 'Blue', data: 'blue' }]] });
    await amy.tell(BOT, { kind: 'bot_cb', qid: 'q1234567890', target: sentId, data: 'blue' });
    const ups = await api(token, 'getUpdates', { timeout: 5 });
    const cq = ups.result.at(-1).callback_query;
    assert.equal(cq.data, 'blue');
    assert.equal(cq.message.message_id, sentId);
    await api(token, 'getUpdates', { offset: ups.result.at(-1).update_id + 1 });
    assert.equal((await api(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Blue it is' })).ok, true);
    const ans = await amy.hear();
    assert.deepEqual(ans.payload, { kind: 'bot_answer', qid: 'q1234567890', text: 'Blue it is' });
  });

  await t.test('editMessageText changes the text and buttons; reply keyboards and their removal', async () => {
    const e = await api(token, 'editMessageText', { chat_id: amy.handle, message_id: sentId, text: 'You picked blue' });
    assert.equal(e.ok, true);
    const got = await amy.hear();
    assert.deepEqual(got.payload, { kind: 'action', act: 'edit', target: sentId, text: 'You picked blue', markup: null });
    await api(token, 'sendMessage', { chat_id: amy.handle, text: 'Yes or no?', reply_markup: { keyboard: [['Yes', 'No']], one_time_keyboard: true } });
    assert.deepEqual((await amy.hear()).payload.markup, { keyboard: [[{ text: 'Yes' }, { text: 'No' }]], once: true });
    await api(token, 'sendMessage', { chat_id: amy.handle, text: 'Thanks', reply_markup: { remove_keyboard: true } });
    assert.deepEqual((await amy.hear()).payload.markup, { remove: true });
    const badMarkup = await api(token, 'sendMessage', { chat_id: amy.handle, text: 'x', reply_markup: { inline_keyboard: [[{ text: 'x', url: 'file:///etc/passwd' }]] } });
    assert.equal(badMarkup.error_code, 400);
  });

  await t.test('commands are public on the profile', async () => {
    assert.equal((await api(token, 'setMyCommands', { commands: [{ command: 'echo', description: 'Say it back' }] })).ok, true);
    await api(token, 'setMyDescription', { description: 'Echoes what you send.' });
    const info = await (await fetch(`${relay.url}/api/bots/info?handle=%2Bechotestbot.veil`)).json();
    assert.equal(info.bot, true);
    assert.deepEqual(info.commands, [{ command: 'echo', description: 'Say it back' }]);
    assert.equal(info.about, 'Echoes what you send.');
    assert.equal((await api(token, 'setMyCommands', { commands: [{ command: 'Bad Name', description: 'x' }] })).error_code, 400);
  });

  await t.test('groups: privacy mode passes only commands, mentions and replies', async () => {
    const ben = await person(relay.port, '@ben.veil');
    const group = { id: 'grp_abcdefghijk', name: 'Team', members: [amy.handle, ben.handle, BOT] };
    for (const text of ['just chatting', '/echo@echotestbot hi all', 'hey +echotestbot']) await amy.tell(BOT, { kind: 'text', text, group });
    await new Promise((r) => setTimeout(r, 300));
    const ups = (await api(token, 'getUpdates', {})).result;
    const msgs = ups.filter((u) => u.message).map((u) => u.message.text);
    assert.deepEqual(msgs, ['/echo@echotestbot hi all', 'hey +echotestbot']);
    assert.ok(ups.some((u) => u.my_chat_member?.chat.id === '#grp_abcdefghijk'), 'the bot learns it was added');
    await api(token, 'getUpdates', { offset: ups.at(-1).update_id + 1 });
    const r = await api(token, 'sendMessage', { chat_id: '#grp_abcdefghijk', text: 'hi team' });
    assert.equal(r.ok, true, JSON.stringify(r));
    for (const p of [amy, ben]) {
      const got = await p.hear();
      assert.equal(got.payload.text, 'hi team');
      assert.deepEqual(got.payload.group, group);
    }
    ben.c.close();
  });

  await t.test('webhook: updates are POSTed with the secret header; getUpdates is refused meanwhile', async () => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { hits.push({ secret: req.headers['x-fabric-bot-api-secret-token'], body: JSON.parse(b) }); res.end('ok'); });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    t.after(() => srv.close());
    assert.equal((await api(token, 'setWebhook', { url: 'ftp://x/' })).error_code, 400);
    assert.equal((await api(token, 'setWebhook', { url: `http://127.0.0.1:${srv.address().port}/hook`, secret_token: 's3cret' })).ok, true);
    assert.equal((await api(token, 'getUpdates', {})).error_code, 409);
    await amy.tell(BOT, { kind: 'text', text: 'via webhook' });
    for (let i = 0; i < 50 && !hits.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(hits[0].secret, 's3cret');
    assert.equal(hits[0].body.message.text, 'via webhook');
    assert.equal((await api(token, 'getWebhookInfo')).result.pending_update_count, 0);
    assert.equal((await api(token, 'deleteWebhook')).ok, true);
  });

  await t.test('rate limits: a chat gets a burst, then 429 with retry_after', async () => {
    let last;
    for (let i = 0; i < 8; i++) {
      last = await api(token, 'sendMessage', { chat_id: amy.handle, text: `n${i}` });
      if (!last.ok) break;
    }
    assert.equal(last.error_code, 429);
    assert.ok(last.parameters.retry_after >= 1);
  });

  await t.test('addresses ending in "bot" are only for bots made with forge', async () => {
    const squat = await person(relay.port, '@sneakybot.veil');
    assert.equal(squat.error, 'handle reserved');
    const squat2 = await person(relay.port, BOT);
    assert.equal(squat2.error, 'handle taken');
  });

  await t.test('forge /mybots -> delete with a confirm button; the token stops working', async () => {
    await amy.tell(FORGE_HANDLE, { kind: 'text', text: '/mybots' });
    let got;
    do got = await amy.hear(); while (!/Your bots/.test(got.payload.text || ''));
    assert.equal(got.payload.markup.inline[0][0].data, `bot:${BOT}`);
    await amy.tell(FORGE_HANDLE, { kind: 'bot_cb', qid: 'qdel0000001', target: got.id, data: `del:${BOT}` });
    await amy.hear(['bot_answer']);
    const confirm = await amy.hear(['action']);
    assert.match(confirm.payload.text, /Delete \+echotestbot/);
    await amy.tell(FORGE_HANDLE, { kind: 'bot_cb', qid: 'qdel0000002', target: got.id, data: `rm:${BOT}` });
    assert.equal((await amy.hear(['bot_answer'])).payload.text, 'Deleted');
    assert.equal((await api(token, 'getMe')).error_code, 401);
    amy.c.close();
  });
});
