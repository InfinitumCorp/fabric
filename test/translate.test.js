import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePrefs, translatingIn, toggleChat, setAuto, shouldAsk, noteFor, stillCurrent,
  theirLanguage, offerReplyIn, textHash, cacheGet, cachePut,
} from '../shared/translate.js';
import { detectLanguage } from '../shared/langdetect.js';
import { translateFrom } from '../shared/ai.js';

test('auto translation is on for a new install, and asked about once', () => {
  const p = normalizePrefs({});
  assert.equal(translatingIn(p, '@ana.veil'), true);
  assert.equal(translatingIn(p, 'g:abc'), true, 'group chats too');
  assert.equal(translatingIn(p, 'space:s1'), true, 'channels and large groups too');
  assert.equal(shouldAsk(p), true);
  setAuto(p, true);
  assert.equal(shouldAsk(p), false);
  assert.equal(translatingIn(p, ''), false, 'no chat, nothing to translate');
});

test('old "Translate every chat" settings carry over', () => {
  const on = normalizePrefs({ translateAll: true, translate: {} });
  assert.equal(on.auto, true);
  assert.equal('translateAll' in on, false);
  assert.equal(shouldAsk(on), false);
  const off = normalizePrefs({ translateAll: false, translate: { '@bo.veil': true } });
  assert.equal(off.auto, undefined, 'never chose: the new default applies, and they are asked');
  assert.equal(translatingIn(off, '@bo.veil'), true);
});

test('the per-chat switch: off in one chat while auto is on, on in one chat while auto is off', () => {
  const p = setAuto(normalizePrefs({}), true);
  assert.equal(toggleChat(p, '@ana.veil'), false);
  assert.deepEqual(p.off, { '@ana.veil': true });
  assert.equal(translatingIn(p, '@bo.veil'), true, 'other chats unaffected');
  assert.equal(toggleChat(p, '@ana.veil'), true);
  assert.deepEqual(p.off, {});

  setAuto(p, false);
  assert.equal(translatingIn(p, '@ana.veil'), false);
  assert.equal(toggleChat(p, '@ana.veil'), true);
  assert.deepEqual(p.translate, { '@ana.veil': true });
  assert.equal(translatingIn(p, '@bo.veil'), false);
  // turning auto back on clears the now-redundant per-chat "on"s but keeps nothing switched off
  setAuto(p, true);
  assert.deepEqual(p.translate, {});
  assert.equal(translatingIn(p, '@ana.veil'), true);
});

test('the line under a translated message', () => {
  const name = (c) => ({ es: 'Spanish' }[c] || c);
  assert.deepEqual(noteFor({ from: 'es', text: 'hi' }, { name }), { label: 'Translated from Spanish', action: 'Show original' });
  assert.deepEqual(noteFor({ from: 'es', text: 'hi' }, { name, open: true }), { label: 'Translated from Spanish', action: 'Hide original' });
  assert.equal(noteFor(null), null);
});

test('a translation is dropped if the message was edited or deleted meanwhile', () => {
  assert.equal(stillCurrent({ text: 'hola' }, 'hola'), true);
  assert.equal(stillCurrent({ text: 'hola, ¿qué tal?' }, 'hola'), false);
  assert.equal(stillCurrent({ text: '', deleted: 1 }, ''), false);
  assert.equal(stillCurrent(undefined, 'hola'), false);
});

test('their language: the most common of their recent messages, never mine', () => {
  const me = '@me.veil';
  const t = [
    { from: '@ana.veil', tr: { from: 'es' } },
    { from: me, text: 'hi' },
    { from: '@ana.veil', tr: { from: 'es' } },
    { from: '@bo.veil', tr: { from: 'fr' } },
    { from: '@system', tr: { from: 'de' } },
  ];
  assert.equal(theirLanguage(t, me, 'en'), 'es');
  assert.equal(theirLanguage([{ from: '@ana.veil', sentTr: { from: 'de' } }], me, 'en'), 'de');
  assert.equal(theirLanguage([{ from: '@ana.veil', tr: { from: 'en' } }], me, 'en'), null, 'same as mine');
  assert.equal(theirLanguage([{ from: '@ana.veil', text: 'hello' }], me, 'en'), null, 'unknown');
  assert.equal(theirLanguage([{ from: '@a', tr: { from: 'es' } }, { from: '@b', tr: { from: 'fr' } }], me, 'en'), 'fr', 'tie: the latest');
});

test('offer to reply in their language: once per chat, only in a translated chat', () => {
  const p = setAuto(normalizePrefs({}), true);
  assert.equal(offerReplyIn(p, '@ana.veil', 'es'), 'es');
  assert.equal(offerReplyIn(p, '@ana.veil', null), null);
  assert.equal(offerReplyIn(p, '@ana.veil', 'xx', { languages: ['es', 'fr'] }), null, 'no model for it');
  p.noOffer['@ana.veil'] = true;
  assert.equal(offerReplyIn(p, '@ana.veil', 'es'), null, 'turned down');
  p.out['@bo.veil'] = 'fr';
  assert.equal(offerReplyIn(p, '@bo.veil', 'es'), null, 'already sending in a language');
  toggleChat(p, '@cy.veil');
  assert.equal(offerReplyIn(p, '@cy.veil', 'es'), null, 'translation off in that chat');
});

test('post translation cache: keyed by text, bounded', () => {
  const c = {};
  cachePut(c, 's1:1', 'hola', { from: 'es', text: 'hello' }, { now: 1 });
  assert.equal(cacheGet(c, 's1:1', 'hola').text, 'hello');
  assert.equal(cacheGet(c, 's1:1', 'adiós'), null, 'text changed');
  assert.equal(cacheGet(c, 's1:2', 'hola'), null);
  for (let i = 0; i < 5; i++) cachePut(c, `k${i}`, 'x', { from: 'es', text: 'y' }, { max: 3, now: 10 + i });
  assert.deepEqual(Object.keys(c).sort(), ['k2', 'k3', 'k4']);
  assert.notEqual(textHash('ab'), textHash('ba'));
  assert.equal(textHash('hola'), textHash('hola'));
});

test('detection decides when a message gets translated', () => {
  const es = 'Hola, ¿cómo estás? Nos vemos mañana';
  assert.equal(translateFrom(detectLanguage(es), 'en', {}, es), 'es');
  const en = 'Hey, see you tomorrow and thanks for this';
  assert.equal(translateFrom(detectLanguage(en), 'en', {}, en), null, 'already mine');
  assert.equal(translateFrom(detectLanguage(en), 'de', {}, en), 'en');
  const ru = 'Привет, как дела? Увидимся завтра';
  assert.equal(translateFrom(detectLanguage(ru), 'en', {}, ru), 'ru');
  assert.equal(translateFrom(detectLanguage('👍🎉'), 'en', {}, '👍🎉'), null, 'nothing to read');
  assert.equal(translateFrom(detectLanguage('ok'), 'en', {}, 'ok'), null, 'too short to tell');
});
