// Shared by the phone and burner tests.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { twilioSignature } from '../server/phone.js';
import { generateUserIdentity, generateSigningKey, ownershipProof } from '../shared/crypto.js';
import { signDeviceList, newDeviceId } from '../shared/devices.js';

export const CFG = {
  accountSid: 'AC' + 'a'.repeat(32), authToken: 'auth-token-test', apiKey: 'SK' + 'b'.repeat(32),
  apiSecret: 'api-secret-test', appSid: 'AP' + 'c'.repeat(32), publicUrl: 'https://fabric.example.test',
  countries: ['+1'], numbers: {},
};
// ---------- against a running relay ----------
export function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  const next = (pred) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for message')), 3000);
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
  return { ws, next, send, ask };
}

export async function signIn(port, handle) {
  const acct = await generateSigningKey();
  const dev = { id: newDeviceId(), keys: await generateUserIdentity() };
  const list = await signDeviceList(acct.privateJwk, {
    handle, version: 1, account: acct.publicJwk,
    devices: [{ id: dev.id, name: 'test', dh: dev.keys.dh.publicJwk, sig: dev.keys.sig.publicJwk, addedAt: 1 }],
  });
  const c = client(port);
  const hello = await c.next((m) => m.type === 'hello');
  const proof = await ownershipProof(dev.keys.dh.privateJwk, hello.relayKey, hello.nonce);
  c.send({ type: 'register', handle, deviceId: dev.id, list, proof });
  const res = await c.next((m) => m.type === 'registered' || m.type === 'error');
  assert.equal(res.type, 'registered', res.error);
  return c;
}

export async function webhook(port, path, params, { sign = true } = {}) {
  const sig = twilioSignature(CFG.authToken, CFG.publicUrl + path, params);
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sign ? { 'x-twilio-signature': sig } : {}) },
    body: new URLSearchParams(params),
  });
  return { status: r.status, body: await r.text() };
}

