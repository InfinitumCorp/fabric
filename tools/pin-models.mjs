// Writes server/model-pins.json: SHA-256, size and commit of every model file the relay may
// pass through. LFS files use the SHA-256 Hugging Face publishes (X-Linked-ETag); the first of
// those is downloaded and checked. Small files are downloaded and hashed here.
//
//   node tools/pin-models.mjs
//
// A file the source does not have is left out. The relay then answers 404 for it and does not
// ask the source again.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MODEL_IDS, modelFiles } from '../shared/models.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'server', 'model-pins.json');

function header(res, name) {
  return res.headers.get(name) || res.headers.get(name.toLowerCase());
}

async function head(url) {
  const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
  return res;
}

async function sha256Of(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const h = createHash('sha256');
  const reader = res.body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
    n += value.length;
  }
  return { sha256: h.digest('hex'), size: n };
}

const models = {};
let checkedLfs = false;
for (const id of MODEL_IDS) {
  const files = {};
  let revision = null;
  for (const file of modelFiles(id)) {
    const url = `https://huggingface.co/${id}/resolve/main/${file}`;
    const res = await head(url);
    if (res.status === 404 || res.status === 401) continue;
    if (res.status !== 200 && res.status !== 302 && res.status !== 307) {
      throw new Error(`${id}/${file}: HTTP ${res.status}`);
    }
    revision = revision || (header(res, 'x-repo-commit') || '').trim();
    const etag = (header(res, 'x-linked-etag') || '').replaceAll('"', '');
    const linked = Number(header(res, 'x-linked-size'));
    if (/^[0-9a-f]{64}$/.test(etag) && Number.isSafeInteger(linked) && linked > 0) {
      if (!checkedLfs) {
        process.stderr.write(`checking LFS SHA-256 of ${id}/${file} (${linked} bytes)\n`);
        const got = await sha256Of(url);
        if (got.sha256 !== etag || got.size !== linked) {
          throw new Error(`${id}/${file}: X-Linked-ETag ${etag} (${linked}) != downloaded ${got.sha256} (${got.size})`);
        }
        checkedLfs = true;
      }
      files[file] = { sha256: etag, size: linked };
      continue;
    }
    process.stderr.write(`hashing ${id}/${file}\n`);
    const got = await sha256Of(url);
    files[file] = { sha256: got.sha256, size: got.size };
  }
  if (!/^[0-9a-f]{40}$/.test(revision || '')) throw new Error(`${id}: no commit (${revision})`);
  if (!Object.keys(files).length) throw new Error(`${id}: no files pinned`);
  models[id] = { revision, files };
  process.stderr.write(`${id}: ${Object.keys(files).length} files @ ${revision.slice(0, 12)}\n`);
}

const body = { generated: new Date().toISOString().slice(0, 10), models };
fs.writeFileSync(out, JSON.stringify(body, null, 2) + '\n');
process.stderr.write(`wrote ${out}\n`);
