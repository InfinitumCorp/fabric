import test from 'node:test';
import assert from 'node:assert/strict';
import { eventOf, eventFallback, rsvpSummary, rsvpLists, eventIcs, eventWhen, MAX_EVENT_SPAN } from '../shared/events.js';
import { applyAction, actionPayload, extrasOf } from '../shared/actions.js';
import { inFolder } from '../shared/desk.js';

const A = '@alice.veil';
const B = '@bob.veil';
const C = '@carol.veil';
const START = Date.UTC(2026, 10, 20, 18, 0);
const ev = { title: '  Dinner  ', start: START, end: START + 2 * 3600_000, place: 'Café Pushkin', note: 'Bring wine' };
const thread = () => [{ id: 'evtAAAAAAAAAAAA1', from: A, text: 'fallback', ts: 1, event: eventOf({ event: ev }) }];

test('eventOf: trims, keeps valid fields, refuses malformed events', () => {
  assert.deepEqual(eventOf({ event: ev }), { title: 'Dinner', start: START, end: START + 7200_000, place: 'Café Pushkin', note: 'Bring wine' });
  assert.equal(eventOf({ event: { title: '', start: START } }), null);
  assert.equal(eventOf({ event: { title: 'x', start: 'tomorrow' } }), null);
  assert.equal(eventOf({ event: { title: 'x', start: START, end: START } }), null, 'end must be after start');
  assert.equal(eventOf({ event: { title: 'x', start: START, end: START + MAX_EVENT_SPAN + 1 } }), null);
  assert.equal(eventOf({ event: { title: 'x', start: 5 } }), null, 'before 2000');
  assert.deepEqual(eventOf({ event: { title: 'x'.repeat(500), start: START, place: '   ' } }), { title: 'x'.repeat(120), start: START });
  assert.equal(eventOf({}), null);
});

test('extrasOf carries an event and a sticker flag (only on images)', () => {
  assert.equal(extrasOf({ event: ev }).event.title, 'Dinner');
  assert.equal(extrasOf({ sticker: true, media: { type: 'image' } }).sticker, true);
  assert.equal(extrasOf({ sticker: true, media: { type: 'file' } }).sticker, undefined);
  assert.equal(extrasOf({ sticker: 'yes', media: { type: 'image' } }).sticker, undefined);
});

test('rsvp: anyone answers once, can change or take it back', () => {
  const t = thread();
  assert.ok(applyAction(t, B, actionPayload('rsvp', t[0].id, { going: 'yes' })));
  assert.ok(applyAction(t, C, actionPayload('rsvp', t[0].id, { going: 'maybe' })));
  assert.ok(applyAction(t, B, actionPayload('rsvp', t[0].id, { going: 'no' })));
  assert.deepEqual(rsvpSummary(t[0], B), { yes: 0, maybe: 1, no: 1, mine: 'no' });
  assert.deepEqual(rsvpLists(t[0]), { yes: [], maybe: [C], no: [B] });
  assert.equal(applyAction(t, B, actionPayload('rsvp', t[0].id, { going: 'perhaps' })), null);
  assert.ok(applyAction(t, B, actionPayload('rsvp', t[0].id, { going: '' })));
  assert.ok(applyAction(t, C, actionPayload('rsvp', t[0].id, { going: '' })));
  assert.equal(t[0].rsvp, undefined, 'empty answers leave nothing behind');
});

test('cancel: only the author; no answers after that; delete clears the event', () => {
  const t = thread();
  assert.equal(applyAction(t, B, actionPayload('cancel', t[0].id)), null);
  assert.ok(applyAction(t, A, actionPayload('cancel', t[0].id), 99));
  assert.equal(t[0].evCancelled, 99);
  assert.equal(applyAction(t, B, actionPayload('rsvp', t[0].id, { going: 'yes' })), null);
  assert.ok(applyAction(t, A, actionPayload('delete', t[0].id)));
  assert.equal(t[0].event, undefined);
  assert.equal(t[0].evCancelled, undefined);
});

test('rsvp on a message without an event is ignored', () => {
  const t = [{ id: 'msgAAAAAAAAAAAA1', from: A, text: 'hi', ts: 1 }];
  assert.equal(applyAction(t, B, actionPayload('rsvp', t[0].id, { going: 'yes' })), null);
});

test('fallback text and time range', () => {
  const e = eventOf({ event: ev });
  const f = eventFallback(e);
  assert.match(f, /^📅 Dinner\n/);
  assert.match(f, /18:00 – 20:00 UTC/);
  assert.match(f, /📍 Café Pushkin/);
  assert.match(eventWhen({ title: 'x', start: START, end: START + 2 * 86400_000 }, 'en-GB', 'UTC'), /20 Nov.*–.*22 Nov/);
});

test('iCalendar file escapes text and uses UTC times', () => {
  const ics = eventIcs({ title: 'A, B; C', start: START, place: 'Line1\nLine2' }, 'evt<1>', Date.UTC(2026, 0, 1));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261120T180000Z\r\n/);
  assert.match(ics, /DTEND:20261120T190000Z\r\n/, 'one hour when there is no end');
  assert.match(ics, /SUMMARY:A\\, B\\; C\r\n/);
  assert.match(ics, /LOCATION:Line1\\nLine2\r\n/);
  assert.match(ics, /UID:evt1@infinitumfabric\.app/);
  assert.ok(ics.split('\r\n').every((l) => l.length <= 75));
});

test('Favourites folder holds chats marked favourite', () => {
  assert.equal(inFolder({ id: 'favourites' }, '@a.veil', { fav: true }), true);
  assert.equal(inFolder({ id: 'favourites' }, '@a.veil', {}), false);
});
