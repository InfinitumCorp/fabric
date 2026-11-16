// Model files for on-device AI (shared/models.js), passed through from the model source and
// cached on disk, so pages load nothing from another origin and the source sees one download per
// file per relay instead of one per device. Only the listed models and their needed files.
//
//   FABRIC_MODELS=0               turn it off (browsers with a built-in model still have AI)
//   FABRIC_MODEL_SOURCE=<url>     where to fetch from (default https://huggingface.co; or a mirror
//                                 with the same /<org>/<repo>/resolve/main/<file> layout)
//   FABRIC_MODEL_DIR=<dir>        cache (default data/models); files put here by hand are served too
//
// What the relay learns: which models a device downloads (so which languages someone translates
// between), not what is translated. Models run on the device; text never comes back here.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { allowedModelFile } from '../shared/models.js';

const PATH_RE = /^\/models\/([A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,96})\/resolve\/main\/([A-Za-z0-9_./-]{1,128})$/;
const MAX_FILE = 1.5e9;
const MAX_PER_IP = 6; // downloads at once
const STALL_MS = 60_000; // a download with no bytes either way this long is dropped

export function modelsFromEnv(env = process.env, root = '.') {
  if (env.FABRIC_MODELS === '0') return null;
  const source = (env.FABRIC_MODEL_SOURCE || 'https://huggingface.co').replace(/\/$/, '');
  if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(source)) throw new Error('FABRIC_MODEL_SOURCE must be an http(s) URL');
  return { source, dir: env.FABRIC_MODEL_DIR || path.join(root, 'data', 'models') };
}

const typeOf = (file) => (file.endsWith('.json') ? 'application/json' : file.endsWith('.jinja') ? 'text/plain; charset=utf-8' : 'application/octet-stream');

/**
 * GET/HEAD with node's own http client, following redirects. (Not fetch: with two downloads at
 * once, a fetch body that has waited for a slow device can stop delivering for good.) Answers in
 * the shape of a fetch Response, with a node stream as the body.
 */
export function nodeFetch(url, { method = 'GET', headers = {} } = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops >= 5) return reject(new Error('too many redirects'));
        return resolve(nodeFetch(new URL(res.headers.location, u).href, { method, headers }, hops + 1));
      }
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: { get: (k) => { const v = res.headers[k.toLowerCase()]; return v == null ? null : String(v); } },
        body: res,
        async arrayBuffer() { const parts = []; for await (const c of res) parts.push(c); return Buffer.concat(parts); },
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('model source timed out')));
    req.on('error', reject);
    req.end();
  });
}

const cancelBody = (body) => { try { if (body?.cancel) body.cancel().catch(() => {}); else body?.destroy?.(); } catch { /* gone */ } };

export function createModelProxy({ source, dir, fetchImpl = nodeFetch, log = () => {} }) {
  const busy = new Map(); // ip → downloads running

  /** The source, retried on a dropped connection (before any byte has gone to the browser). */
  async function fetchUpstream(url, method, range = null) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetchImpl(url, {
          method, redirect: 'follow',
          // the bytes as stored: fetch would unzip a compressed body, and its length would no longer match
          headers: { 'accept-encoding': 'identity', ...(range ? { range } : {}) },
        });
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
  }

  /** Handles /models/…; returns false for any other path. */
  async function handle(req, res, url, ip) {
    if (!url.pathname.startsWith('/models/')) return false;
    const m = PATH_RE.exec(url.pathname);
    if (!m || m[2].includes('..') || !allowedModelFile(m[1], m[2])) { res.writeHead(404); res.end('not found'); return true; }
    const [, id, file] = m;
    const local = path.join(dir, id, file);
    const headers = (size) => ({ 'content-type': typeOf(file), 'cache-control': 'public, max-age=604800, immutable', 'accept-ranges': 'bytes', ...(size != null ? { 'content-length': size } : {}) });
    // Transformers.js asks for "bytes=0-0" first to learn a file's size
    const range = /^bytes=(\d{1,12})-(\d{0,12})$/.exec(String(req.headers.range || ''));

    if (fs.existsSync(local)) {
      const { size } = fs.statSync(local);
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1);
        if (start >= size || end < start) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return true; }
        res.writeHead(206, { ...headers(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` });
        if (req.method === 'HEAD') { res.end(); return true; }
        fs.createReadStream(local, { start, end }).pipe(res);
        return true;
      }
      res.writeHead(200, headers(size));
      if (req.method === 'HEAD') { res.end(); return true; }
      fs.createReadStream(local).pipe(res);
      return true;
    }
    if (range) {
      // part of a file not cached yet: pass the range through, small, not cached
      const want = Number(range[2] || 0) - Number(range[1]);
      if (!range[2] || want < 0 || want > 1 << 20) { res.writeHead(416); res.end(); return true; }
      try {
        const up = await fetchUpstream(`${source}/${id}/resolve/main/${file}`, 'GET', req.headers.range);
        if (up.status !== 206) {
          cancelBody(up.body); // a source that ignores ranges: don't read the whole file for one byte
          res.writeHead(up.status === 404 ? 404 : up.ok ? 416 : 502); res.end(); return true;
        }
        const buf = Buffer.from(await up.arrayBuffer()).subarray(0, want + 1);
        const cr = up.headers.get('content-range');
        res.writeHead(206, { ...headers(buf.length), ...(cr ? { 'content-range': cr } : {}) });
        res.end(req.method === 'HEAD' ? undefined : buf);
      } catch (e) {
        if (!res.headersSent) { res.writeHead(502); res.end('model source unavailable'); }
      }
      return true;
    }
    if ((busy.get(ip) || 0) >= MAX_PER_IP) { res.writeHead(429, { 'retry-after': '5' }); res.end('too many downloads at once'); return true; }
    busy.set(ip, (busy.get(ip) || 0) + 1);
    const tmp = `${local}.${randomBytes(6).toString('hex')}.part`;
    try {
      const up = await fetchUpstream(`${source}/${id}/resolve/main/${file}`, req.method === 'HEAD' ? 'HEAD' : 'GET');
      if (!up.ok) { res.writeHead(up.status === 404 ? 404 : 502); res.end(up.status === 404 ? 'not found' : 'model source unavailable'); return true; }
      const encoded = (up.headers.get('content-encoding') || 'identity') !== 'identity';
      const size = encoded ? null : Number(up.headers.get('content-length')) || null;
      if (size && size > MAX_FILE) { res.writeHead(502); res.end('model file too large'); return true; }
      res.writeHead(200, headers(size));
      if (req.method === 'HEAD' || !up.body) { res.end(); return true; }
      // to the browser and into the cache at once; the cache file appears only when complete
      fs.mkdirSync(path.dirname(local), { recursive: true });
      const out = fs.createWriteStream(tmp);
      let got = 0;
      let gone = false;
      res.on('close', () => { if (!res.writableFinished) gone = true; });
      const body = up.body.getReader ? Readable.fromWeb(up.body) : up.body;
      // wait until a stream can take more (a slow device slows the fetch), or give up
      const drained = (w) => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('stalled')), STALL_MS);
        const done = () => { clearTimeout(t); w.off('close', closed); resolve(); };
        const closed = () => { clearTimeout(t); w.off('drain', done); reject(new Error('client went away')); };
        w.once('drain', done);
        w.once('close', closed);
      });
      let stall = null;
      const arm = () => { clearTimeout(stall); stall = setTimeout(() => body.destroy(new Error('stalled')), STALL_MS); };
      try {
        arm();
        for await (const chunk of body) {
          arm();
          if (gone) throw new Error('client went away');
          got += chunk.length;
          if (got > MAX_FILE) throw new Error('model file too large');
          out.write(chunk);
          res.write(chunk);
          // check each after the other: one may drain while we wait for the other
          if (out.writableNeedDrain) await drained(out);
          if (res.writableNeedDrain) await drained(res);
        }
      } catch (e) {
        body.destroy();
        out.destroy();
        throw e;
      } finally {
        clearTimeout(stall);
      }
      res.end();
      await new Promise((r) => out.end(r));
      if (!size || got === size) fs.renameSync(tmp, local);
      log(`[models] cached ${id}/${file} (${(got / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      log(`[models] ${id}/${file}: ${e.message || e}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`);
      if (!res.headersSent) { res.writeHead(502); res.end('model source unavailable'); } else res.destroy();
    } finally {
      fs.rm(tmp, { force: true }, () => {});
      const n = (busy.get(ip) || 1) - 1;
      if (n) busy.set(ip, n); else busy.delete(ip);
    }
    return true;
  }

  return { handle };
}
