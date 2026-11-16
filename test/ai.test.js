import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transcript, summaryLines, parseReplies, translateFrom, baseLang, languageName, cleanLine,
  MAX_REPLY, MAX_REPLIES, SMART_REPLY_SCHEMA,
} from '../shared/ai.js';

const me = '@amy.veil';
const msgs = [
  { from: '@ben.veil', text: 'Hey, are we still on for Friday?' },
  { from: '@system', text: 'Voice call · 0:24' },
  { from: me, text: 'Yes! 7pm at the usual place.' },
  { from: '@ben.veil', text: 'Great, I will bring the tickets.' },
];

test('transcript: You/Them only, no handles, system lines dropped, cut from the oldest end', () => {
  const t = transcript(msgs, me);
  assert.equal(t, 'Them: Hey, are we still on for Friday?\nYou: Yes! 7pm at the usual place.\nThem: Great, I will bring the tickets.');
  assert.ok(!t.includes('@ben') && !t.includes('@amy'));
  const short = transcript(msgs, me, { maxChars: 75 }); // room for the last two lines only
  assert.equal(short, 'You: Yes! 7pm at the usual place.\nThem: Great, I will bring the tickets.');
  assert.equal(transcript([], me), '');
});

test('model output is cleaned before it reaches the page', () => {
  // bidi overrides and control characters could make a suggestion read differently than it is
  assert.equal(cleanLine('ok‮  evil\u0007\n text'), 'ok evil text');
  assert.equal(cleanLine('x'.repeat(500), 10).length, 10);
  assert.deepEqual(summaryLines('* Friday at 7pm\n- Ben brings tickets\n\n1. Open: none\n• done'), ['Friday at 7pm', 'Ben brings tickets', 'Open: none', 'done']);
});

test('suggested replies: JSON as asked, or whatever list the model gave, at most three, short', () => {
  assert.deepEqual(parseReplies('{"replies":["Sounds good!","See you then","Thanks!"]}'), ['Sounds good!', 'See you then', 'Thanks!']);
  assert.deepEqual(parseReplies('```json\n["a","b"]\n```'), ['a', 'b']);
  assert.deepEqual(parseReplies('1. Sure\n2. "No thanks"\n- Maybe later\n- Another\n'), ['Sure', 'No thanks', 'Maybe later']);
  assert.deepEqual(parseReplies('{"replies":["Same","same","", 42, null, "Other"]}'), ['Same', 'Other']);
  const long = parseReplies(JSON.stringify({ replies: ['y'.repeat(300)] }))[0];
  assert.equal(long.length, MAX_REPLY);
  assert.equal(parseReplies(JSON.stringify({ replies: ['1', '2', '3', '4', '5'] })).length, MAX_REPLIES);
  assert.deepEqual(parseReplies(''), []);
  assert.equal(SMART_REPLY_SCHEMA.properties.replies.maxItems, MAX_REPLIES);
});

test('translation: only when the detector is sure and the language differs', () => {
  const es = [{ detectedLanguage: 'es', confidence: 0.93 }];
  assert.equal(translateFrom(es, 'en-US', {}, 'hola, qué tal'), 'es');
  assert.equal(translateFrom(es, 'es-MX', {}, 'hola, qué tal'), null, 'already in the target language');
  assert.equal(translateFrom([{ detectedLanguage: 'es', confidence: 0.4 }], 'en', {}, 'hola amigo'), null, 'unsure');
  assert.equal(translateFrom([{ detectedLanguage: 'und', confidence: 1 }], 'en', {}, '👍👍👍👍'), null);
  assert.equal(translateFrom(es, 'en', {}, 'ok'), null, 'too short to tell');
  assert.equal(translateFrom([], 'en', {}, 'hola amigo'), null);
  assert.equal(translateFrom([{ detectedLanguage: 'pt-BR', confidence: 0.9 }], 'en', {}, 'obrigado amigo'), 'pt');
  assert.equal(baseLang('en-US'), 'en');
  assert.equal(baseLang(''), 'en');
  assert.equal(languageName('es'), 'Spanish');
  assert.equal(languageName('not a code!'), 'not a code!');
});
