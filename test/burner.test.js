// Burner numbers: the record shared with ÆTHER, bundles, and the relay lending numbers from
// its pool, routing calls and texts through them, rotating and burning them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newBurner, validBurner, burn, rotate, reconcile, lineFor, BUNDLES, BURNER_V,
} from '../shared/burner.js';
import { phoneFromEnv } from '../server/phone.js';
import { createRelay } from '../server/relay.js';
import { CFG, signIn, webhook } from './phone-helpers.js';

const envOf = (c) => ({
  TWILIO_ACCOUNT_SID: c.accountSid, TWILIO_AUTH_TOKEN: c.authToken, TWILIO_API_KEY_SID: c.apiKey,
  TWILIO_API_KEY_SECRET: c.apiSecret, TWILIO_TWIML_APP_SID: c.appSid, FABRIC_PUBLIC_URL: c.publicUrl,
});

test('burner record: the v1 shape shared with ÆTHER, burn and rotate', () => {
  const r = newBurner({ number: '+15550002001', label: 'Market‮', now: 1000, bundleId: 'b1' });
  assert.deepEqual(Object.keys(r).sort(), ['bundleId', 'burnedAt', 'createdAt', 'id', 'label', 'network', 'number', 'rotatedFrom', 'scope', 'state', 'v']);
  assert.equal(r.v, BURNER_V);
  assert.equal(r.network, 'pstn');
  assert.equal(r.label, 'Market', 'control and bidi characters dropped');
  assert.match(r.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(r.state, 'active');
  assert.equal(r.burnedAt, null);
  assert.ok(validBurner(r));
  assert.throws(() => newBurner({ number: '555-0100' }), /invalid/);
  assert.ok(validBurner(newBurner({ network: 'aether-mesh', number: '7334829173' })), 'an ÆTHER mesh number');
  assert.throws(() => newBurner({ network: 'aether-mesh', number: '733482917' }), /invalid/);
  assert.ok(validBurner({ ...r, state: 'rotating' }), 'ÆTHER marks a record rotating while it swaps');
  assert.ok(!validBurner({ ...r, state: 'burned' }), 'burned needs burnedAt');
  assert.ok(!validBurner({ ...r, burnedAt: 5 }), 'active has no burnedAt');

  const b = burn(r, 2000);
  assert.equal(b.state, 'burned');
  assert.equal(b.burnedAt, 2000);
  assert.ok(validBurner(b));
  assert.equal(burn(b, 3000).burnedAt, 2000, 'burning twice changes nothing');

  const [old, fresh] = rotate(r, '+15550002002', 4000);
  assert.equal(old.state, 'burned');
  assert.equal(fresh.rotatedFrom, r.id);
  assert.equal(fresh.label, 'Market');
  assert.equal(fresh.bundleId, 'b1');
  assert.notEqual(fresh.id, r.id);

  // the device follows the relay: lines gone there are burned here; new ones get records
  const out = reconcile([r], [{ number: '+15550002003', createdAt: 5000, rotatedFrom: '+15550002001' }], 6000);
  assert.equal(out[0].state, 'burned');
  assert.equal(out[1].number, '+15550002003');
  assert.equal(out[1].rotatedFrom, r.id, 'rotated on another device: the label carries over');
  assert.equal(out[1].label, 'Market');
  assert.equal(lineFor(out, { '+15557654321': out[1].id }, '+15557654321').number, '+15550002003');
  assert.equal(lineFor(out, { '+15557654321': r.id }, '+15557654321'), null, 'a burned number is never used');
});

test('burner config: bundles of 1, 2 or 5; pool, checkout and cooldown from the environment', () => {
  assert.deepEqual(BUNDLES, [1, 2, 5]);
  const cfg = phoneFromEnv({ ...envOf(CFG), FABRIC_BURNER_POOL: '+15550002001, nope,+15550002002', FABRIC_BURNER_CHECKOUT_URL: 'javascript:alert(1)' });
  assert.deepEqual(cfg.burner.pool, ['+15550002001', '+15550002002']);
  assert.equal(cfg.burner.checkoutUrl, null, 'https only');
  assert.equal(cfg.burner.cooldownMs, 90 * 86_400_000);
});

test('relay: burner numbers lent from the pool, routed, rotated and burned', async (t) => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ sid: 'SM' + '2'.repeat(32) }), { status: 201 });
  };
  const phone = { ...CFG, burner: { enabled: true, pool: ['+15550003001', '+15550003002'], cooldownMs: 60_000, checkoutUrl: 'https://pay.example.test/fabric' } };
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, phone, fetchImpl, operatorToken: 'op' });
  t.after(() => relay.close());
  const { port } = relay;
  const base = `http://127.0.0.1:${port}`;
  const op = (path, body, auth = 'Bearer op') => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: auth }, body: body && JSON.stringify(body) });
  const ana = await signIn(port, '@ana.veil');
  const ben = await signIn(port, '@ben.veil');
  t.after(() => { ana.ws.close(); ben.ws.close(); });

  // no bundle, no burner; what's on offer is shown
  const st = await ana.ask({ type: 'phone_status' }, 'phone_status');
  assert.equal(st.burners.slots, 0);
  assert.equal(st.burners.available, true);
  assert.equal(st.burners.checkoutUrl, 'https://pay.example.test/fabric');
  assert.deepEqual(st.burners.bundleSizes, [1, 2, 5]);
  assert.equal('prices' in st.burners, false, 'no pricing');
  await assert.rejects(ana.ask({ type: 'burner_create' }, 'burner_created'), /add a bundle/);

  // the pool and bundles are the operator's
  assert.equal((await op('/api/phone/pool', null, 'Bearer nope')).status, 403);
  assert.deepEqual(await (await op('/api/phone/pool')).json(), { total: 2, free: 2, lent: 0 });
  assert.equal((await op('/api/phone/pool', { add: ['bad'] })).status, 400);
  assert.equal((await op('/api/phone/bundles', { handle: '@ana.veil', size: 3, period: 'month' })).status, 400);
  assert.equal((await op('/api/phone/bundles', { handle: '@nobody.veil', size: 1, period: 'month' })).status, 400);
  assert.equal((await op('/api/phone/bundles', { handle: '@ana.veil', size: 1, period: 'month' }, 'Bearer nope')).status, 403);
  const g = await (await op('/api/phone/bundles', { handle: '@ana.veil', size: 1, period: 'year', id: 'order-1' })).json();
  assert.equal(g.size, 1);
  assert.ok(g.expiresAt > Date.now() + 360 * 86_400_000);
  assert.equal((await ana.next((m) => m.type === 'phone_status' && !m.ref)).burners.slots, 1, 'pushed to the account');

  // one tap: a burner; no main number needed to call
  const made = await ana.ask({ type: 'burner_create' }, 'burner_created');
  assert.equal(made.line, '+15550003001');
  assert.equal(made.number, null, 'the main number stays the main number');
  assert.deepEqual(made.burners.lines.map((l) => l.number), ['+15550003001']);
  await assert.rejects(ana.ask({ type: 'burner_create' }, 'burner_created'), /no free burner slots/);
  assert.equal((await ana.ask({ type: 'phone_token' }, 'phone_token')).identity, 'ana');
  assert.deepEqual(await (await op('/api/phone/pool')).json(), { total: 1, free: 1, lent: 1 });
  assert.equal((await op('/api/phone/numbers', { number: '+15550003001', handle: '@ben.veil' })).status, 409, 'a lent burner cannot be reassigned');

  // calls and texts to the burner ring ana, marked with the line they came in on
  const inc = await webhook(port, '/api/phone/incoming', { To: '+15550003001', From: '+15557654321', CallSid: 'CA' + '7'.repeat(32) });
  assert.match(inc.body, /<Identity>ana<\/Identity><Parameter name="from" value="\+15557654321"\/><Parameter name="via" value="\+15550003001"\/>/);
  assert.equal((await ana.next((m) => m.type === 'phone_event')).event.via, '+15550003001');
  await webhook(port, '/api/phone/sms', { To: '+15550003001', From: '+15557654321', Body: 'who is this?' });
  assert.equal((await ana.next((m) => m.type === 'phone_event' && m.event.kind === 'sms')).event.text, 'who is this?');

  // calling and texting out from it: the other side sees only the burner
  const out = await webhook(port, '/api/phone/voice', { From: 'client:ana', To: '+15557654321', Via: '+15550003001', CallSid: 'CA' + '6'.repeat(32) });
  assert.match(out.body, /<Dial callerId="\+15550003001"/);
  assert.match((await webhook(port, '/api/phone/voice', { From: 'client:ben', To: '+15557654321', Via: '+15550003001' })).body, /no longer yours/, 'only its owner');
  assert.match((await webhook(port, '/api/phone/voice', { From: 'client:ana', To: '+15557654321' })).body, /no phone number/, 'no main number: no fallback');
  const sms = await ana.ask({ type: 'sms_send', to: '+15557654321', text: 'a friend', via: '+15550003001' }, 'sms_sent');
  assert.equal(sms.event.via, '+15550003001');
  assert.equal(new URLSearchParams(sent.at(-1).init.body).get('From'), '+15550003001');
  await assert.rejects(ben.ask({ type: 'sms_send', to: '+15557654321', text: 'x', via: '+15550003001' }, 'sms_sent'), /no longer yours/);
  assert.equal((await ana.ask({ type: 'phone_log' }, 'phone_log')).events.length, 4);

  // rotate: a fresh number in one step; the old one stops ringing and its history is forgotten
  await assert.rejects(ben.ask({ type: 'burner_rotate', number: '+15550003001' }, 'burner_rotated'), /not one of your burners/);
  const rot = await ana.ask({ type: 'burner_rotate', number: '+15550003001' }, 'burner_rotated');
  assert.equal(rot.line, '+15550003002');
  assert.deepEqual(rot.burners.lines, [{ number: '+15550003002', createdAt: rot.burners.lines[0].createdAt, rotatedFrom: '+15550003001' }]);
  assert.match((await webhook(port, '/api/phone/incoming', { To: '+15550003001', From: '+15557654321' })).body, /not in service/);
  assert.equal((await ana.ask({ type: 'phone_log' }, 'phone_log')).events.length, 0, 'the old line’s calls and texts are gone from the relay');
  assert.deepEqual(await (await op('/api/phone/pool')).json(), { total: 1, free: 0, lent: 1 }, 'the burned number rests before anyone gets it');
  await assert.rejects(ana.ask({ type: 'burner_rotate', number: '+15550003002' }, 'burner_rotated'), /no numbers are free/);
  assert.deepEqual((await ana.ask({ type: 'phone_status' }, 'phone_status')).burners.lines.map((l) => l.number), ['+15550003002'], 'a failed rotate keeps the number');

  // burn
  const burned = await ana.ask({ type: 'burner_burn', number: '+15550003002' }, 'burner_burned');
  assert.deepEqual(burned.burners.lines, []);
  await webhook(port, '/api/phone/sms', { To: '+15550003002', From: '+15557654321', Body: 'x' });
  assert.equal((await ana.ask({ type: 'phone_log' }, 'phone_log')).events.length, 0, 'texts to a burned number reach nobody');
  await assert.rejects(ana.ask({ type: 'burner_burn', number: '+15550003002' }, 'burner_burned'), /not one of your burners/);

  // a bundle that runs out takes its lines with it
  await op('/api/phone/pool', { add: ['+15550003003'] });
  await op('/api/phone/bundles', { handle: '@ben.veil', size: 1, period: 'month', id: 'order-2', expiresAt: Date.now() + 300 });
  const benLine = await ben.ask({ type: 'burner_create' }, 'burner_created');
  assert.equal(benLine.line, '+15550003003');
  await new Promise((r) => setTimeout(r, 350));
  relay.expirePhone();
  assert.match((await webhook(port, '/api/phone/incoming', { To: '+15550003003', From: '+15557654321' })).body, /not in service/);
});
