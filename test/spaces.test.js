// Large groups and channels, FabriC++ Plus entitlements and test-mode checkout, sponsored posts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { createRelay } from '../server/relay.js';
import { paymentsFromEnv, verifyStripeSignature } from '../server/plus.js';
import { generateUserIdentity, generateSigningKey, ownershipProof } from '../shared/crypto.js';
import { signDeviceList, newDeviceId } from '../shared/devices.js';
import { channelHandle, can, postBody, REACTIONS } from '../shared/spaces.js';
import { TIERS } from '../shared/tiers.js';

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = []; const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  const next = (pred) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => { waiters.push({ pred, resolve }); setTimeout(() => reject(new Error('timeout')), 3000); });
  };
  let ref = 0;
  const send = (o) => ws.send(JSON.stringify(o));
  const ask = async (o) => {
    const r = String(++ref);
    send({ ...o, ref: r });
    const m = await next((x) => x.ref === r);
    if (m.type === 'error') throw Object.assign(new Error(m.error), { status: m.status });
    return m;
  };
  return { ws, next, send, ask, close: () => ws.close() };
}

async function account(handle, n = 1) {
  const acct = await generateSigningKey();
  const devices = [];
  for (let i = 0; i < n; i++) devices.push({ id: newDeviceId(), name: `D${i}`, keys: await generateUserIdentity() });
  const entry = (d) => ({ id: d.id, name: d.name, dh: d.keys.dh.publicJwk, sig: d.keys.sig.publicJwk, addedAt: 1 });
  const listOf = (devs, version) => signDeviceList(acct.privateJwk, { handle, version, account: acct.publicJwk, devices: devs.map(entry) });
  return { handle, acct, devices, list: await listOf(devices, 1), listOf, entry };
}

async function signIn(port, a, list = a.list) {
  const c = client(port);
  const hello = await c.next((m) => m.type === 'hello');
  const proof = await ownershipProof(a.devices[0].keys.dh.privateJwk, hello.relayKey, hello.nonce);
  c.send({ type: 'register', handle: a.handle, deviceId: a.devices[0].id, list, proof });
  const res = await c.next((m) => m.type === 'registered' || m.type === 'error');
  if (res.type === 'error') throw new Error(res.error);
  return c;
}

const box = (e = 0, bytes = 32) => ({ e, iv: Buffer.alloc(12, 1).toString('base64'), ct: Buffer.alloc(bytes, 2).toString('base64') });
let pid = 0;
const postId = () => `post${String(++pid).padStart(6, '0')}`;

test('shared rules: addresses, roles, post bodies', () => {
  assert.equal(channelHandle('+Daily_News'), '@daily_news.veil');
  assert.equal(channelHandle('daily.veil'), '@daily.veil');
  assert.equal(channelHandle('+x'), null);
  assert.ok(can('member', 'post', 'group'));
  assert.ok(!can('member', 'post', 'channel'), 'subscribers read, admins post');
  assert.ok(can('admin', 'post', 'channel'));
  assert.ok(!can('admin', 'promote', 'channel'), 'only the owner makes admins');
  assert.deepEqual(postBody({ text: ' hi ' }, 'public', 1e6), { text: 'hi' });
  assert.equal(postBody({ text: 'plain' }, 'private', 1e6), null, 'private spaces only take ciphertext');
  assert.ok(postBody(box(), 'private', 1e6));
  assert.equal(postBody(box(0, 3000), 'private', 1000), null, 'over the plan size');
});

test('large groups and channels on the relay', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {} });
  t.after(() => relay.close());
  const { port } = relay;
  const [A, B, C] = await Promise.all(['@ann.veil', '@ben.veil', '@cy.veil'].map((h) => account(h)));
  const a = await signIn(port, A); const b = await signIn(port, B); const c = await signIn(port, C);
  t.after(() => { a.close(); b.close(); c.close(); });

  await assert.rejects(a.ask({ type: 'space_create', kind: 'group', visibility: 'public', name: 'G' }), /groups are private/);

  // ----- private large group: members post ciphertext -----
  const { space: g } = await a.ask({ type: 'space_create', kind: 'group', visibility: 'private', name: 'Climbers' });
  assert.equal(g.role, 'owner');
  assert.equal(g.e2ee, true);
  await assert.rejects(b.ask({ type: 'space_posts', sid: g.id }), /not a member/);
  const { invite } = await a.ask({ type: 'space_invite_create', sid: g.id, maxUses: 2 });
  const preview = await c.ask({ type: 'space_resolve', invite: invite.code });
  assert.equal(preview.space.name, 'Climbers');
  await b.ask({ type: 'space_join', invite: invite.code });
  const joined = await a.next((m) => m.type === 'space_member' && m.handle === B.handle);
  assert.equal(joined.op, 'join');
  await assert.rejects(b.ask({ type: 'space_post', sid: g.id, id: postId(), body: { text: 'plaintext' } }), /malformed/);
  const { post } = await b.ask({ type: 'space_post', sid: g.id, id: postId(), body: box() });
  assert.equal(post.author, B.handle, 'group posts show who wrote them');
  const live = await a.next((m) => m.type === 'space_post');
  assert.deepEqual(live.post.body, box());

  // reactions: one per person, from a fixed set; views once per reader
  await assert.rejects(a.ask({ type: 'space_react', sid: g.id, seq: post.seq, emoji: 'lol' }), /unsupported/);
  await a.ask({ type: 'space_react', sid: g.id, seq: post.seq, emoji: REACTIONS[0] });
  const r2 = await b.ask({ type: 'space_react', sid: g.id, seq: post.seq, emoji: REACTIONS[0] });
  assert.equal(r2.reactions[REACTIONS[0]], 2);
  assert.equal(r2.mine, REACTIONS[0]);
  const r3 = await b.ask({ type: 'space_react', sid: g.id, seq: post.seq, emoji: REACTIONS[1] });
  assert.deepEqual(r3.reactions, { [REACTIONS[0]]: 1, [REACTIONS[1]]: 1 }, 'changing a reaction replaces it');
  await a.ask({ type: 'space_view', sid: g.id, seqs: [post.seq] });
  await a.ask({ type: 'space_view', sid: g.id, seqs: [post.seq] });
  const v = await b.ask({ type: 'space_view', sid: g.id, seqs: [post.seq] });
  assert.equal(v.views[post.seq], 2, 'two readers, counted once each');

  // removal: the relay stops serving them at once, bans the rejoin, and asks for a new key
  await c.ask({ type: 'space_join', invite: invite.code });
  const rm = await a.ask({ type: 'space_remove', sid: g.id, handle: C.handle });
  assert.equal(rm.rotate, true);
  await c.next((m) => m.type === 'space_gone' && m.sid === g.id);
  await assert.rejects(c.ask({ type: 'space_posts', sid: g.id }), /not a member/);
  await assert.rejects(c.ask({ type: 'space_join', invite: invite.code }), /expired|removed/);
  const rot = await a.ask({ type: 'space_rotate', sid: g.id });
  assert.equal(rot.epoch, 1);
  assert.deepEqual(rot.members.sort(), [A.handle, B.handle]);
  await assert.rejects(b.ask({ type: 'space_post', sid: g.id, id: postId(), body: box(0) }), /stale key epoch/);
  await b.ask({ type: 'space_post', sid: g.id, id: postId(), body: box(1) });
  await assert.rejects(b.ask({ type: 'space_remove', sid: g.id, handle: A.handle }), /not allowed/);

  // ----- public channel: an address anyone can join, admins post plaintext -----
  const { space: ch } = await a.ask({ type: 'space_create', kind: 'channel', visibility: 'public', name: 'Ann Daily', handle: '+anndaily', topic: 'tech' });
  assert.equal(ch.handle, '@anndaily.veil');
  assert.equal(ch.e2ee, false);
  await assert.rejects(b.ask({ type: 'space_create', kind: 'channel', visibility: 'public', name: 'X', handle: '+anndaily' }), /taken/);
  await assert.rejects(b.ask({ type: 'space_create', kind: 'channel', visibility: 'public', name: 'X', handle: '+ben' }), /taken/, 'an account’s address');
  await b.ask({ type: 'space_join', handle: '+anndaily.veil' });
  await c.ask({ type: 'space_join', handle: '@anndaily.veil' });
  await assert.rejects(b.ask({ type: 'space_post', sid: ch.id, id: postId(), body: { text: 'hi' } }), /not allowed/, 'subscribers read only');
  await a.ask({ type: 'space_role', sid: ch.id, handle: B.handle, role: 'admin' });
  await b.next((m) => m.type === 'space_role' && m.role === 'admin');
  const p2 = await b.ask({ type: 'space_post', sid: ch.id, id: postId(), body: { text: 'Release notes' } });
  assert.equal(p2.post.author, B.handle, 'admins see which admin posted');
  const seen = await c.next((m) => m.type === 'space_post' && m.post.sid === ch.id);
  assert.equal(seen.post.author, null, 'subscribers see the channel, not the admin');
  await assert.rejects(c.ask({ type: 'space_members', sid: ch.id }), /only admins/);
  const mem = await a.ask({ type: 'space_members', sid: ch.id });
  assert.equal(mem.total, 3);
  await assert.rejects(b.ask({ type: 'space_role', sid: ch.id, handle: C.handle, role: 'admin' }), /not allowed/);

  // readable without an account (that is what public means)
  const pub = await (await fetch(`${relay.url}/api/channels/${encodeURIComponent('+anndaily.veil')}`)).json();
  assert.equal(pub.space.name, 'Ann Daily');
  assert.equal(pub.posts[0].body.text, 'Release notes');
  assert.equal(pub.posts[0].author, null);
  assert.equal(pub.space.owner, undefined);
  assert.equal((await fetch(`${relay.url}/api/channels/%2Bnope.veil`)).status, 404);
  // a private space is never previewable by address
  const list = await a.ask({ type: 'space_list' });
  assert.equal(list.spaces.length, 2);

  // the channel's address can't be registered as an account
  const squat = await account('@anndaily.veil');
  await assert.rejects(signIn(port, squat), /handle taken/);

  // deleting a post and the space
  await a.ask({ type: 'space_delete_post', sid: ch.id, seq: p2.post.seq });
  assert.equal((await c.ask({ type: 'space_posts', sid: ch.id })).posts.length, 0);
  await assert.rejects(b.ask({ type: 'space_remove_space', sid: ch.id }), /not allowed/);
  await a.ask({ type: 'space_remove_space', sid: ch.id });
  await c.next((m) => m.type === 'space_gone' && m.sid === ch.id);
});

test('plans: limits by tier, stub activation, operator grants, device cap', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, payments: { mode: 'stub' } });
  t.after(() => relay.close());
  const A = await account('@owner.veil', 6);
  const a = await signIn(relay.port, A, await A.listOf(A.devices.slice(0, 5), 1));
  t.after(() => a.close());
  const st = await a.next((m) => m.type === 'plus_status');
  assert.equal(st.plan.tier, 'free');
  assert.equal(st.plan.devices, TIERS.free.devices);
  assert.equal(st.checkout, true);

  // a 6th device is over the free plan
  await assert.rejects(a.ask({ type: 'update_devices', list: await A.listOf(A.devices, 2) }), /allows 5 devices/);

  // the group member cap follows the owner's plan
  relay.plus.grant; // exists
  const { space: g } = await a.ask({ type: 'space_create', kind: 'group', visibility: 'private', name: 'Big' });
  for (let i = 0; i < TIERS.free.groupMembers - 1; i++) relay.store.db.prepare("INSERT INTO space_members (sid, handle, role, joined_at) VALUES (?, ?, 'member', 0)").run(g.id, `@m${i}.veil`);
  const { invite } = await a.ask({ type: 'space_invite_create', sid: g.id });
  const B = await account('@late.veil');
  const b = await signIn(relay.port, B);
  t.after(() => b.close());
  await assert.rejects(b.ask({ type: 'space_join', invite: invite.code }), /full \(1,000 members/);

  // stub checkout: Plus at no charge, for development
  const co = await a.ask({ type: 'plus_checkout' });
  assert.equal(co.stub, true);
  assert.equal(co.plan.tier, 'plus');
  assert.equal(co.plan.ads, false);
  await b.ask({ type: 'space_join', invite: invite.code }); // owner's plan now allows 20,000
  await a.ask({ type: 'update_devices', list: await A.listOf(A.devices, 2) });

  // the Plus mark: shown unless turned off; nothing else about the plan is public
  assert.deepEqual((await b.ask({ type: 'badges', handles: [A.handle, B.handle] })).plus, [A.handle]);
  await a.ask({ type: 'plus_badge', show: false });
  assert.deepEqual((await b.ask({ type: 'badges', handles: [A.handle] })).plus, []);

  // operator grants (local requests, no token configured)
  const g1 = await (await fetch(`${relay.url}/api/plus/grants`, { method: 'POST', body: JSON.stringify({ handle: B.handle, days: 30 }) })).json();
  assert.equal(g1.tier, 'plus');
  const g0 = await (await fetch(`${relay.url}/api/plus/grants`, { method: 'POST', body: JSON.stringify({ handle: B.handle, days: 0 }) })).json();
  assert.equal(g0.tier, 'free');
  assert.equal((await fetch(`${relay.url}/api/plus/grants`, { method: 'POST', body: JSON.stringify({ handle: '@ghost.veil', days: 3 }) })).status, 400);
  const plans = await (await fetch(`${relay.url}/api/plans`)).json();
  assert.equal(plans.payments, 'stub');
  assert.deepEqual(plans.tiers.map((x) => x.id), ['free', 'plus']);
});

test('payments: only Stripe test mode, signed webhooks, no live events', async (t) => {
  assert.equal(paymentsFromEnv({ FABRIC_PAYMENTS: 'live' }, () => {}).mode, 'off', 'live is refused');
  assert.equal(paymentsFromEnv({}, () => {}).mode, 'off', 'off by default');
  assert.equal(paymentsFromEnv({ FABRIC_PAYMENTS: 'test', FABRIC_PLUS_CHECKOUT_URL: 'https://buy.stripe.com/abc123' }, () => {}).checkoutUrl, null, 'a live link is ignored');
  const secret = 'whsec_testsecret';
  const payments = paymentsFromEnv({ FABRIC_PAYMENTS: 'test', FABRIC_PLUS_CHECKOUT_URL: 'https://buy.stripe.com/test_abc123', FABRIC_STRIPE_WEBHOOK_SECRET: secret }, () => {});
  assert.equal(payments.checkoutUrl, 'https://buy.stripe.com/test_abc123');

  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, payments });
  t.after(() => relay.close());
  const A = await account('@payer.veil');
  const a = await signIn(relay.port, A);
  t.after(() => a.close());
  const co = await a.ask({ type: 'plus_checkout' });
  const u = new URL(co.url);
  assert.equal(u.host, 'buy.stripe.com');
  const ref = u.searchParams.get('client_reference_id');
  assert.match(ref, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(!co.url.includes('payer'), 'Stripe never sees the +name');

  const hook = (ev, { sign = secret, ts = Math.floor(Date.now() / 1000) } = {}) => {
    const body = JSON.stringify(ev);
    const sig = createHmac('sha256', sign).update(`${ts}.${body}`).digest('hex');
    return fetch(`${relay.url}/api/plus/stripe`, { method: 'POST', body, headers: { 'stripe-signature': `t=${ts},v1=${sig}` } });
  };
  const done = { id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test_1', client_reference_id: ref, subscription: 'sub_1' } } };
  assert.equal((await hook(done, { sign: 'whsec_wrong' })).status, 400, 'bad signature');
  assert.equal((await hook(done, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 400, 'too old');
  assert.equal((await hook({ ...done, id: 'evt_live', livemode: true })).status, 400, 'live events are refused');
  const ok = await hook(done);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).granted, true);
  const st = await a.next((m) => m.type === 'plus_status' && m.plan.tier === 'plus');
  assert.equal(st.plan.source, 'stripe-test');
  assert.equal((await (await hook(done)).json()).duplicate, true, 'events are processed once');
  const renew = await hook({ id: 'evt_2', type: 'invoice.paid', livemode: false, data: { object: { subscription: 'sub_1', lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 90 * 86400 } }] } } } });
  assert.equal((await renew.json()).renewed, true);
  assert.ok(relay.plus.entitlements(A.handle).expiresAt > Date.now() + 89 * 86400_000);
  assert.ok(!verifyStripeSignature('t=1,v1=00', '{}', secret));
});

test('sponsored posts: contextual, capped, labelled, never for Plus', async (t) => {
  let now = Date.UTC(2026, 10, 9, 12);
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, payments: { mode: 'stub' }, clock: () => now, operatorToken: 'op-secret' });
  t.after(() => relay.close());
  const api = (path, body, method = body ? 'POST' : 'GET', token = 'op-secret') => fetch(`${relay.url}${path}`, {
    method, body: body && JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  assert.equal((await api('/api/ads/campaigns', null, 'GET', null)).status, 403, 'operator only');
  assert.equal((await api('/api/ads/campaigns', { name: 'x', advertiser: 'Y', headline: 'h', url: 'http://plain.example', placement: 'chatlist' })).status, 400, 'https only');
  assert.equal((await api('/api/ads/campaigns', { name: 'x', advertiser: 'Y', headline: 'h', url: 'https://a.example', placement: 'chatlist', topics: ['tech'] })).status, 400, 'no targeting in the chat list');
  const list = await (await api('/api/ads/campaigns', { name: 'Notebooks', advertiser: 'Paper Co', headline: 'Paper that lasts', body: 'Made slowly.', url: 'https://paper.example/', placement: 'chatlist', status: 'active', freqCap: 2 })).json();
  const tech = await (await api('/api/ads/campaigns', { name: 'Keyboards', advertiser: 'Keys Inc', headline: 'Quiet keys', url: 'https://keys.example/', placement: 'channel', topics: ['tech'], status: 'active' })).json();
  await api('/api/ads/campaigns', { name: 'Recipes', advertiser: 'Cook', headline: 'Soup', url: 'https://cook.example/', placement: 'channel', topics: ['food'], status: 'active' });

  const A = await account('@reader.veil'); const O = await account('@chan.veil');
  const a = await signIn(relay.port, A); const o = await signIn(relay.port, O);
  t.after(() => { a.close(); o.close(); });

  // chat list: labelled, explained, and capped per day
  const first = await a.ask({ type: 'ads_fetch', placement: 'chatlist' });
  assert.equal(first.ad.label, 'Sponsored');
  assert.equal(first.ad.id, list.id);
  assert.ok(first.ad.why.some((w) => /Never used: your messages/.test(w)));
  await a.ask({ type: 'ads_fetch', placement: 'chatlist' });
  assert.equal((await a.ask({ type: 'ads_fetch', placement: 'chatlist' })).ad, null, 'frequency cap of 2 per day');
  now += 86400_000;
  assert.ok((await a.ask({ type: 'ads_fetch', placement: 'chatlist' })).ad, 'a new day');

  // clicks are counted once per day per person; the url goes straight to the advertiser
  assert.equal((await a.ask({ type: 'ads_click', id: list.id })).url, 'https://paper.example/');
  await a.ask({ type: 'ads_click', id: list.id });
  const stats = await (await api(`/api/ads/campaigns/${list.id}`)).json();
  assert.equal(stats.impressions, 3);
  assert.equal(stats.clicks, 1);

  // public channels get ads matched to the channel's topic; private spaces never do
  const { space: pubCh } = await o.ask({ type: 'space_create', kind: 'channel', visibility: 'public', name: 'Tech Talk', handle: '+techtalk', topic: 'tech' });
  const { space: privCh } = await o.ask({ type: 'space_create', kind: 'channel', visibility: 'private', name: 'Secret' });
  const inCh = await a.ask({ type: 'ads_fetch', placement: 'channel', sid: pubCh.id });
  assert.equal(inCh.ad.id, tech.id, 'the tech campaign, not the food one');
  assert.ok(inCh.ad.why.some((w) => /about tech/.test(w)));
  assert.equal((await a.ask({ type: 'ads_fetch', placement: 'channel', sid: privCh.id })).ad, null);
  await o.ask({ type: 'space_edit', sid: pubCh.id, ads: false });
  assert.equal((await a.ask({ type: 'ads_fetch', placement: 'channel', sid: pubCh.id })).reason, 'off for this channel');

  // pausing stops a campaign
  await api(`/api/ads/campaigns/${list.id}`, { status: 'paused' }, 'PATCH');
  assert.equal((await o.ask({ type: 'ads_fetch', placement: 'chatlist' })).ad, null);
  await api(`/api/ads/campaigns/${list.id}`, { status: 'active' }, 'PATCH');

  // Plus: no ads anywhere
  await a.ask({ type: 'plus_checkout' });
  const none = await a.ask({ type: 'ads_fetch', placement: 'chatlist' });
  assert.equal(none.ad, null);
  assert.equal(none.reason, 'plus');
});

test('oversized messages: only space posts may exceed the envelope size', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, payments: { mode: 'stub' } });
  t.after(() => relay.close());
  const A = await account('@big.veil');
  const a = await signIn(relay.port, A);
  const { space: g } = await a.ask({ type: 'space_create', kind: 'group', visibility: 'private', name: 'Media' });
  await assert.rejects(a.ask({ type: 'space_post', sid: g.id, id: postId(), body: box(0, 2 * 1024 * 1024) }), /too large for your plan/);
  await a.ask({ type: 'plus_checkout' });
  await a.ask({ type: 'space_post', sid: g.id, id: postId(), body: box(0, 2 * 1024 * 1024) });
  const closed = new Promise((r) => a.ws.on('close', r));
  a.send({ type: 'lookup', handle: '@x.veil', pad: 'x'.repeat(600 * 1024) });
  assert.equal(await closed, 1009);
});
