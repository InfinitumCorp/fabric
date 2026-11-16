// A development stand-in for Cumulus://ID™: a minimal OpenID Connect provider with a few test
// accounts, so CID sign-in can be built and tested before the real service is reachable.
// Authorization code flow with PKCE (S256) only, ES256-signed ID tokens, codes good for one use
// within 60 seconds. It listens on 127.0.0.1 only and has no passwords: picking an account
// signs in as it. Never expose it.
//
//   npm run cid-dev            # http://localhost:8790
//   CID_DEV_REDIRECTS=http://localhost:8788/cid-callback.html,...   allowed redirect addresses

import http from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign as signData } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const DEV_ACCOUNTS = [
  { email: 'alex@cumulusmail.cloud', name: 'Alex Rivera' },
  { email: 'sam@cumulusmail.cloud', name: 'Sam Okafor' },
  { email: 'jordan@cumulusmail.cloud', name: 'Jordan Lee' },
];

const PAGE_CSS = `
*{box-sizing:border-box;border-radius:0}body{margin:0;background:#fff;color:#141619;font:15px/1.5 Arial,Helvetica,sans-serif}
main{max-width:440px;margin:8vh auto;padding:0 16px}.eyebrow{font:10px/1.4 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.12em;text-transform:uppercase;color:#525A5B}
h1{font-weight:400;font-size:34px;letter-spacing:-.02em;margin:8px 0 4px}p{color:#525A5B}.dev{border:1px solid #D6DCE1;padding:10px 12px;font-size:13px;margin:18px 0}
form{display:grid;gap:8px;margin-top:18px}button{font:inherit;padding:12px 14px;text-align:left;border:1px solid #D6DCE1;background:#fff;color:#141619;cursor:pointer}
button:hover{border-color:#141619}button.primary{background:#17191D;color:#fff;border-color:#17191D;text-align:center}button.cancel{text-align:center;color:#525A5B}
.who b{display:block}.who span{font-size:13px;color:#525A5B}.client{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function createDevIssuer({
  port = 8790,
  host = '127.0.0.1',
  issuer: issuerOpt = null, // default http://localhost:<port>; with port 0, the port picked at listen
  clients = { 'fabric-dev': { redirects: (process.env.CID_DEV_REDIRECTS || 'http://localhost:8788/cid-callback.html,http://localhost:8787/cid-callback.html').split(',').map((s) => s.trim()) } },
  accounts = DEV_ACCOUNTS,
  now = () => Date.now(),
} = {}) {
  let issuer = issuerOpt || `http://localhost:${port}`;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kid = b64url(randomBytes(8));
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
  const requests = new Map(); // request id -> authorize params (while the account page is open)
  const codes = new Map(); // code -> { clientId, redirectUri, challenge, nonce, account, expires }
  const subOf = (email) => b64url(createHash('sha256').update(`cid-dev|${email}`).digest()).slice(0, 22);

  function idToken(clientId, account, nonce) {
    const t = Math.floor(now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
    const body = b64url(JSON.stringify({
      iss: issuer, sub: subOf(account.email), aud: clientId, iat: t, exp: t + 300, nonce,
      email: account.email, email_verified: true, name: account.name, amr: ['dev'],
    }));
    const sig = signData('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${head}.${body}.${b64url(sig)}`;
  }

  const redirectWith = (res, uri, params) => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' });
    res.end();
  };

  async function body(req) {
    let s = '';
    for await (const c of req) { s += c; if (s.length > 20_000) throw new Error('too large'); }
    return s;
  }

  async function onRequest(req, res) {
    const url = new URL(req.url, issuer);
    const send = (code, type, text, extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(text); };
    const json = (code, obj) => send(code, 'application/json', JSON.stringify(obj), { 'access-control-allow-origin': '*' });
    const html = (code, title, inner) => send(code, 'text/html; charset=utf-8', page(title, inner), {
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    });

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'], code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile'], token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });

    if (url.pathname === '/authorize' && req.method === 'GET') {
      const p = Object.fromEntries(url.searchParams);
      const client = clients[p.client_id];
      // never redirect to an address the client didn't register
      if (!client || !client.redirects.includes(p.redirect_uri)) return html(400, 'Cumulus://ID', '<p class="eyebrow">Cumulus://ID · development</p><h1>Unknown app</h1><p>This app or its return address is not registered.</p>');
      if (p.response_type !== 'code') return redirectWith(res, p.redirect_uri, { error: 'unsupported_response_type', state: p.state });
      if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || '')) return redirectWith(res, p.redirect_uri, { error: 'invalid_request', error_description: 'PKCE S256 required', state: p.state });
      if (!String(p.scope || '').split(' ').includes('openid')) return redirectWith(res, p.redirect_uri, { error: 'invalid_scope', state: p.state });
      const id = b64url(randomBytes(18));
      requests.set(id, { ...p, expires: now() + 10 * 60_000 });
      const choices = accounts.map((a, i) => `<button name="account" value="${i}" class="who"><b>${esc(a.name)}</b><span>${esc(a.email)}</span></button>`).join('');
      return html(200, 'Sign in · Cumulus://ID', `
        <p class="eyebrow">Infinitum Corporation · Cumulus://ID™</p>
        <h1>Choose an account</h1>
        <p>to continue to <span class="client">${esc(p.client_id)}</span>. It will see your name and email address.</p>
        <div class="dev">Development stand-in: these are test accounts with no password. The real Cumulus://ID asks for your passkey here.</div>
        <form method="post" action="/authorize/decision"><input type="hidden" name="request" value="${esc(id)}">${choices}
        <button name="deny" value="1" class="cancel">Cancel</button></form>`);
    }

    if (url.pathname === '/authorize/decision' && req.method === 'POST') {
      const f = new URLSearchParams(await body(req));
      const r = requests.get(f.get('request') || '');
      if (!r || r.expires < now()) return html(400, 'Cumulus://ID', '<h1>This sign-in expired</h1><p>Start again from the app.</p>');
      requests.delete(f.get('request'));
      if (f.get('deny')) return redirectWith(res, r.redirect_uri, { error: 'access_denied', state: r.state });
      const account = accounts[Number(f.get('account'))];
      if (!account) return html(400, 'Cumulus://ID', '<h1>Unknown account</h1>');
      const code = b64url(randomBytes(24));
      codes.set(code, { clientId: r.client_id, redirectUri: r.redirect_uri, challenge: r.code_challenge, nonce: r.nonce, account, expires: now() + 60_000 });
      return redirectWith(res, r.redirect_uri, { code, state: r.state });
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const f = new URLSearchParams(await body(req));
      const c = codes.get(f.get('code') || '');
      if (c) codes.delete(f.get('code')); // one use, even if this attempt fails
      const bad = (d) => json(400, { error: 'invalid_grant', error_description: d });
      if (f.get('grant_type') !== 'authorization_code') return json(400, { error: 'unsupported_grant_type' });
      if (!c || c.expires < now()) return bad('code unknown, used or expired');
      if (f.get('client_id') !== c.clientId || f.get('redirect_uri') !== c.redirectUri) return bad('client or redirect mismatch');
      const v = f.get('code_verifier') || '';
      if (b64url(createHash('sha256').update(v).digest()) !== c.challenge) return bad('PKCE verifier does not match');
      return json(200, { token_type: 'Bearer', access_token: b64url(randomBytes(24)), expires_in: 300, id_token: idToken(c.clientId, c.account, c.nonce) });
    }

    return json(404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch(() => { if (!res.headersSent) { res.writeHead(400); res.end(); } });
  });
  const sweep = setInterval(() => {
    const t = now();
    for (const m of [requests, codes]) for (const [k, v] of m) if (v.expires < t) m.delete(k);
  }, 60_000);
  sweep.unref();

  return {
    get issuer() { return issuer; },
    server, jwk,
    listen: () => new Promise((r) => server.listen(port, host, () => {
      const p = server.address().port;
      if (!issuerOpt && port === 0) issuer = `http://127.0.0.1:${p}`;
      r(p);
    })),
    close: () => new Promise((r) => { clearInterval(sweep); server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.CID_DEV_PORT || 8790);
  const dev = createDevIssuer({ port });
  dev.listen().then(() => {
    console.log(`[cid-dev] Cumulus://ID development stand-in on ${dev.issuer} (test accounts, no passwords; local only)`);
    console.log(`[cid-dev] run the relay with FABRIC_CID_ISSUER=${dev.issuer} FABRIC_CID_CLIENT_ID=fabric-dev`);
  });
}
