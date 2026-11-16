import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAVED, inFolder, cleanFolder, expireMutes, muteLabel, dueScheduled, validScheduleTime, linksIn, sharedOf,
  messageOnDay, formatTokens, plainText, exportChat, exportFileName, shortcutFor, shortcutLabel, lockDue, noteAccount,
} from '../shared/desk.js';
import { extrasOf } from '../shared/actions.js';

test('built-in folders sort chats by kind', () => {
  assert.equal(inFolder({ id: 'all' }, '@a.veil', {}), true);
  assert.equal(inFolder({ id: 'unread' }, '@a.veil', { unread: 2 }), true);
  assert.equal(inFolder({ id: 'unread' }, '@a.veil', { unread: 0 }), false);
  assert.equal(inFolder({ id: 'personal' }, '@a.veil', {}), true);
  assert.equal(inFolder({ id: 'personal' }, SAVED, {}), false);
  assert.equal(inFolder({ id: 'personal' }, '#g', { group: true }), false);
  assert.equal(inFolder({ id: 'groups' }, '#g', { group: true }), true);
});

test('custom folders: chosen chats, types, exclusions and muted', () => {
  const f = cleanFolder({ id: 'fabc1234', name: '  Work  ', types: ['groups', 'nope'], chats: ['@a.veil', '@a.veil'], exclude: ['#x'], hideMuted: 1 });
  assert.deepEqual(f, { id: 'fabc1234', name: 'Work', types: ['groups'], chats: ['@a.veil'], exclude: ['#x'], hideMuted: true });
  assert.equal(inFolder(f, '@a.veil', {}), true);
  assert.equal(inFolder(f, '@b.veil', {}), false);
  assert.equal(inFolder(f, '#g', { group: true }), true);
  assert.equal(inFolder(f, '#x', { group: true }), false);
  assert.equal(inFolder(f, '#g', { group: true, muted: true }), false);
  assert.equal(cleanFolder({ id: 'bad', name: 'x' }), null);
  assert.equal(cleanFolder({ id: 'fabc1234', name: '   ' }), null);
});

test('timed mutes expire', () => {
  const now = 1_000_000;
  const prefs = { a: { muted: true, mutedUntil: now - 1 }, b: { muted: true, mutedUntil: now + 7200e3 }, c: { muted: true } };
  assert.equal(muteLabel(prefs.b, now), 'Muted for 2 h');
  assert.equal(muteLabel(prefs.c, now), 'Muted');
  assert.equal(expireMutes(prefs, now), true);
  assert.equal(prefs.a.muted, undefined);
  assert.equal(prefs.b.muted, true);
  assert.equal(expireMutes(prefs, now), false);
});

test('scheduled messages: due ones come out oldest first', () => {
  const now = 10_000_000;
  const { due, later } = dueScheduled([{ id: 'b', at: now - 5 }, { id: 'c', at: now + 5 }, { id: 'a', at: now - 50 }], now);
  assert.deepEqual(due.map((s) => s.id), ['a', 'b']);
  assert.deepEqual(later.map((s) => s.id), ['c']);
  assert.equal(validScheduleTime(now + 60e3, now), true);
  assert.equal(validScheduleTime(now + 10e3, now), false);
  assert.equal(validScheduleTime(now + 400 * 864e5, now), false);
});

test('shared media, links and jump to date', () => {
  const t = [
    { id: '1', from: '@a.veil', ts: 100, text: 'see https://example.com/x, and http://a.b/c?d=1.' },
    { id: '2', from: '@a.veil', ts: 200, text: '', media: { type: 'image' } },
    { id: '3', from: '@system', ts: 250, text: 'call https://no.example' },
    { id: '4', from: '@me.veil', ts: 300, text: '', media: { type: 'audio' } },
    { id: '5', from: '@me.veil', ts: 400, text: '', media: { type: 'file' }, deleted: true },
    { id: '6', from: '@me.veil', ts: 500, text: 'doc', media: { type: 'file' } },
  ];
  assert.deepEqual(linksIn(t[0].text), ['https://example.com/x', 'http://a.b/c?d=1']);
  const s = sharedOf(t);
  assert.deepEqual(s.media.map((m) => m.id), ['2']);
  assert.deepEqual(s.voice.map((m) => m.id), ['4']);
  assert.deepEqual(s.files.map((m) => m.id), ['6']);
  assert.equal(s.links.length, 2);
  assert.equal(messageOnDay(t, 150).id, '2');
  assert.equal(messageOnDay(t, 260).id, '4');
  assert.equal(messageOnDay(t, 9999).id, '6');
  assert.equal(messageOnDay([], 0), null);
});

test('formatting becomes tokens, never HTML', () => {
  assert.deepEqual(formatTokens('a **b** __c__ ~~d~~ `e` ||f||'), [
    { t: 'text', v: 'a ' }, { t: 'b', v: 'b' }, { t: 'text', v: ' ' }, { t: 'i', v: 'c' }, { t: 'text', v: ' ' },
    { t: 's', v: 'd' }, { t: 'text', v: ' ' }, { t: 'code', v: 'e' }, { t: 'text', v: ' ' }, { t: 'hide', v: 'f' },
  ]);
  assert.deepEqual(formatTokens('```x **y**```'), [{ t: 'pre', v: 'x **y**' }]);
  assert.deepEqual(formatTokens('go https://x.io/a now'), [{ t: 'text', v: 'go ' }, { t: 'link', v: 'https://x.io/a' }, { t: 'text', v: ' now' }]);
  assert.deepEqual(formatTokens('2 * 3 ** 4 and a_b__'), [{ t: 'text', v: '2 * 3 ** 4 and a_b__' }]);
  assert.deepEqual(formatTokens('<img src=x onerror=1>'), [{ t: 'text', v: '<img src=x onerror=1>' }]);
  assert.equal(plainText('**hi** ||secret||'), 'hi ▒▒▒▒▒▒');
});

test('chat export in three formats escapes content and drops media unless asked', () => {
  const thread = [
    { id: 'm1', from: '@me.veil', ts: Date.UTC(2026, 0, 2, 3, 4), text: '<script>alert(1)</script>', out: [{}], receiptSent: true },
    { id: 'm2', from: '@b.veil', ts: Date.UTC(2026, 0, 2, 3, 5), text: 'pic', media: { type: 'image', mime: 'image/png', name: 'a.png', data: 'AAAA' } },
    { id: 'm3', from: '@system', ts: Date.UTC(2026, 0, 2, 3, 6), text: 'Missed call' },
  ];
  const html = exportChat({ name: '@b.veil', me: '@me.veil', thread, format: 'html' });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('base64,AAAA'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(exportChat({ name: 'x', me: '@me.veil', thread, format: 'html', media: true }).includes('data:image/png;base64,AAAA'));
  const txt = exportChat({ name: '@b.veil', me: '@me.veil', thread, format: 'txt' });
  assert.match(txt, /You: <script>/);
  assert.match(txt, /\[photo: a\.png\] pic/);
  const json = JSON.parse(exportChat({ name: '@b.veil', me: '@me.veil', thread, format: 'json' }));
  assert.equal(json.messages.length, 3);
  assert.equal(json.messages[0].out, undefined);
  assert.equal(json.messages[1].media.data, undefined);
  assert.equal(exportFileName('@b.veil', 'txt', Date.UTC(2026, 10, 9, 12)), 'fabric-b-20261109.txt');
});

test('keyboard shortcuts', () => {
  const k = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.deepEqual(shortcutFor(k('k', { ctrlKey: true })), { action: 'search' });
  assert.deepEqual(shortcutFor(k('k', { metaKey: true }), { mac: true }), { action: 'search' });
  assert.equal(shortcutFor(k('k', { metaKey: true })), null);
  assert.deepEqual(shortcutFor(k('3', { ctrlKey: true })), { action: 'folder', n: 3 });
  assert.deepEqual(shortcutFor(k('M', { ctrlKey: true, shiftKey: true })), { action: 'mute' });
  assert.deepEqual(shortcutFor(k('ArrowDown', { altKey: true })), { action: 'next' });
  assert.deepEqual(shortcutFor(k('ArrowUp')), { action: 'editLast' });
  assert.equal(shortcutFor(k('ArrowUp'), { typing: true }), null);
  assert.equal(shortcutFor(k('a')), null);
  assert.equal(shortcutLabel('mod+shift+M'), 'Ctrl+Shift+M');
  assert.equal(shortcutLabel('mod+shift+M', true), '⌘⇧M');
});

test('auto-lock and accounts', () => {
  assert.equal(lockDue(0, 0, 1e9), false);
  assert.equal(lockDue(0, 5, 5 * 60e3), true);
  assert.equal(lockDue(0, 5, 5 * 60e3 - 1), false);
  let list = noteAccount([], 'default', '@a.veil', 1);
  list = noteAccount(list, 'work', '@b.veil', 2);
  list = noteAccount(list, 'default', '@a.veil', 3);
  assert.deepEqual(list.map((a) => a.profile), ['default', 'work']);
  assert.deepEqual(noteAccount([{ profile: '../x', handle: 'z' }], 'p', '@c.veil', 1).map((a) => a.profile), ['p']);
});

test('silent flag travels with a message', () => {
  assert.equal(extrasOf({ silent: true }).silent, true);
  assert.equal(extrasOf({ silent: 'yes' }).silent, undefined);
});

// ---------- tier 2: pinned messages, polls, disappearing messages ----------
import { applyAction, actionPayload, pollOf, pollFallback, pollSummary, expireThread, isTtl, ttlLabel } from '../shared/actions.js';

test('pin: anyone in the chat pins and unpins; deleted messages cannot be pinned', () => {
  const t = [{ id: 'msg00001', from: '@a.veil', text: 'x', ts: 1 }];
  assert.ok(applyAction(t, '@b.veil', actionPayload('pin', 'msg00001', { on: true }), 50));
  assert.equal(t[0].pinned, 50);
  assert.ok(applyAction(t, '@a.veil', actionPayload('pin', 'msg00001', { on: false })));
  assert.equal(t[0].pinned, undefined);
  assert.equal(applyAction(t, '@a.veil', { kind: 'action', act: 'pin', target: 'msg00001', on: 'yes' }), null);
  applyAction(t, '@a.veil', actionPayload('delete', 'msg00001'));
  assert.equal(applyAction(t, '@b.veil', actionPayload('pin', 'msg00001', { on: true })), null);
});

test('polls: checked on arrival, one ballot each, author closes', () => {
  assert.equal(pollOf({ poll: { q: 'Lunch?', options: ['a'] } }), null);
  assert.equal(pollOf({ poll: { q: 'Lunch?', options: ['a', 'a'] } }), null);
  assert.equal(pollOf({ poll: { q: ' ', options: ['a', 'b'] } }), null);
  const poll = pollOf({ poll: { q: 'Lunch?', options: ['Noodles', 'Salad', 'Soup'], multi: 'no' } });
  assert.deepEqual(poll, { q: 'Lunch?', options: ['Noodles', 'Salad', 'Soup'] });
  assert.match(pollFallback(poll), /📊 Lunch\?\n1\. Noodles\n2\. Salad\n3\. Soup/);
  assert.equal(extrasOf({ poll: { q: 'Q', options: ['x', 'y'], multi: true } }).poll.multi, true);
  const t = [{ id: 'poll0001', from: '@a.veil', text: pollFallback(poll), ts: 1, poll }];
  const vote = (who, choices) => applyAction(t, who, actionPayload('vote', 'poll0001', { choices }));
  assert.ok(vote('@b.veil', [1]));
  assert.ok(vote('@c.veil', [1]));
  assert.ok(vote('@a.veil', [0]));
  assert.equal(vote('@b.veil', [0, 1]), null); // single choice
  assert.equal(vote('@b.veil', [7]), null);
  assert.ok(vote('@c.veil', [2])); // changed their mind
  assert.deepEqual(pollSummary(t[0], '@c.veil'), { counts: [1, 1, 1], voters: 3, mine: [2], closed: false });
  assert.ok(vote('@c.veil', [])); // took it back
  assert.equal(pollSummary(t[0], '@c.veil').voters, 2);
  assert.equal(applyAction(t, '@b.veil', actionPayload('close', 'poll0001')), null); // not the author
  assert.ok(applyAction(t, '@a.veil', actionPayload('close', 'poll0001'), 99));
  assert.equal(vote('@d.veil', [0]), null); // closed
  assert.equal(pollSummary(t[0], '@a.veil').closed, true);
  const multi = [{ id: 'poll0002', from: '@a.veil', text: '', ts: 1, poll: { q: 'Q', options: ['x', 'y'], multi: true } }];
  assert.ok(applyAction(multi, '@b.veil', actionPayload('vote', 'poll0002', { choices: [1, 0, 1] })));
  assert.deepEqual(multi[0].votes['@b.veil'], [0, 1]);
});

test('disappearing messages: only the listed timers, removed when due', () => {
  assert.equal(isTtl(3600), true);
  assert.equal(isTtl(5), false);
  assert.equal(extrasOf({ ttl: 86400 }).ttl, 86400);
  assert.equal(extrasOf({ ttl: 12 }).ttl, undefined);
  assert.equal(ttlLabel(604800), '1 week');
  const t = [
    { id: 'a', ts: 0, ttl: 3600 }, { id: 'b', ts: 0 }, { id: 'c', ts: 3000e3, ttl: 3600 }, { id: 'd', from: '@system', ts: 0 },
  ];
  assert.equal(expireThread(t, 3600e3), 1);
  assert.deepEqual(t.map((m) => m.id), ['b', 'c', 'd']);
});
