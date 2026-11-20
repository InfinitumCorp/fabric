// Phone history is sealed to the account's devices. The relay stores the box, not the call or the text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { generateUserIdentity } from '../shared/crypto.js';
import { signDeviceList, newDeviceId } from '../shared/devices.js';
import { generateSigningKey } from '../shared/crypto.js';
import { isPhoneBox, sealToDevices, openSeal } from '../shared/sealbox.js';
import { openStore } from '../server/store.js';
import { migratePlainPhone } from '../server/phone.js';

test('a phone box opens only for a device it was sealed to, and only for its own row', async () => {
  const a = await generateUserIdentity();
  const b = await generateUserIdentity();
  const c = await generateUserIdentity();
  const devices = [
    { id: newDeviceId(), dh: a.dh.publicJwk },
    { id: newDeviceId(), dh: b.dh.publicJwk },
  ];
  const payload = { kind: 'sms', dir: 'in', peer: '+15557654321', text: 'hello <b>secret</b>' };
  const box = await sealToDevices({ payload, handle: '@ana.veil', seq: 7, devices });
  assert.equal(isPhoneBox(box), true);
  const raw = JSON.stringify(box);
  assert.equal(raw.includes('hello'), false);
  assert.equal(raw.includes('+15557654321'), false);
  assert.equal(raw.includes('secret'), false);

  const opened = await openSeal({ box, handle: '@ana.veil', seq: 7, deviceId: devices[0].id, privateKey: a.dh.privateJwk });
  assert.deepEqual(opened, payload);
  assert.deepEqual(
    await openSeal({ box, handle: '@ana.veil', seq: 7, deviceId: devices[1].id, privateKey: b.dh.privateJwk }),
    payload,
  );
  await assert.rejects(
    openSeal({ box, handle: '@ana.veil', seq: 7, deviceId: newDeviceId(), privateKey: c.dh.privateJwk }),
    /not sealed for this device/,
  );
  await assert.rejects(
    openSeal({ box, handle: '@ana.veil', seq: 8, deviceId: devices[0].id, privateKey: a.dh.privateJwk }),
    /operation/i,
  );
  await assert.rejects(
    openSeal({ box, handle: '@ben.veil', seq: 7, deviceId: devices[0].id, privateKey: a.dh.privateJwk }),
    /operation/i,
  );

  const audio = await sealToDevices({
    payload: { mime: 'audio/mpeg', audio: 'AQID' },
    handle: '@ana.veil', seq: 7, devices: [devices[0]],
    aad: 'phone-audio|@ana.veil|7',
  });
  assert.equal(JSON.stringify(audio).includes('AQID'), false);
  assert.deepEqual(
    await openSeal({ box: audio, handle: '@ana.veil', seq: 7, deviceId: devices[0].id, privateKey: a.dh.privateJwk, aad: 'phone-audio|@ana.veil|7' }),
    { mime: 'audio/mpeg', audio: 'AQID' },
  );
  await assert.rejects(
    openSeal({ box: audio, handle: '@ana.veil', seq: 7, deviceId: devices[0].id, privateKey: a.dh.privateJwk }),
    /operation/i,
  );
});

test('plaintext phone rows are sealed on startup, or deleted when the account has no device', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-phone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openStore(path.join(dir, 'fabric.db'));
  t.after(() => store.close());
  const acct = await generateSigningKey();
  const dev = { id: newDeviceId(), keys: await generateUserIdentity() };
  const list = await signDeviceList(acct.privateJwk, {
    handle: '@ana.veil', version: 1, account: acct.publicJwk,
    devices: [{ id: dev.id, name: 'test', dh: dev.keys.dh.publicJwk, sig: dev.keys.sig.publicJwk, addedAt: 1 }],
  });
  store.putList('@ana.veil', list);
  store.db.prepare('INSERT INTO phone_log (handle, at, event, call_sid, via) VALUES (?, ?, ?, ?, ?)')
    .run('@ana.veil', 10, JSON.stringify({ kind: 'sms', dir: 'in', peer: '+15557654321', text: 'old plaintext', via: '+15550003001' }), null, null);
  store.db.prepare('INSERT INTO phone_log (handle, at, event, call_sid) VALUES (?, ?, ?, ?)')
    .run('@nobody.veil', 11, JSON.stringify({ kind: 'sms', text: 'drop me' }), null);

  assert.equal(await migratePlainPhone(store), 2);
  const rows = store.db.prepare('SELECT handle, event, via FROM phone_log').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].handle, '@ana.veil');
  assert.equal(rows[0].via, '+15550003001');
  assert.equal(rows[0].event.includes('old plaintext'), false);
  assert.equal(rows[0].event.includes('+15557654321'), false);
  const box = JSON.parse(rows[0].event);
  assert.equal(isPhoneBox(box), true);
  assert.equal((await openSeal({ box, handle: '@ana.veil', seq: 1, deviceId: dev.id, privateKey: dev.keys.dh.privateJwk })).text, 'old plaintext');
  assert.equal(await migratePlainPhone(store), 0, 'a second start does not reseal');
});
