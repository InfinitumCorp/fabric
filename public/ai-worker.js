// Runs the open on-device models (shared/models.js) with Transformers.js, off the main thread.
// Code and model files come from this relay (/vendor, /models); the browser keeps the models in
// its cache after the first download. Text in, text out: nothing here talks to anyone else.
//
//   { id, op: 'translate', models: [id…], text }      → { id, text }
//   { id, op: 'generate', messages, maxTokens }       → { id, text }
//   { id, op: 'load', what: 'assistant' | [id…] }     → { id, ok }
//   progress while downloading                        → { id, progress: 0..1 }

import { pipeline, env } from '/vendor/transformers.js';
import { ASSISTANT_MODEL, ASSISTANT_DTYPE } from '/shared/models.js';

env.allowLocalModels = false;
env.remoteHost = `${self.location.origin}/models/`;
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/vendor/ort/`;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const loaded = new Map(); // model id → Promise<pipeline>
let gpu = null;

async function hasF16Gpu() {
  if (gpu !== null) return gpu;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    gpu = Boolean(adapter?.features.has('shader-f16'));
  } catch { gpu = false; }
  return gpu;
}

/** Download progress over all files of one load, as one number. */
function progressFor(id) {
  const files = new Map();
  return (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files.set(p.file, [p.loaded, p.total]);
    let a = 0;
    let b = 0;
    for (const [l, t] of files.values()) { a += l; b += t; }
    self.postMessage({ id, progress: b ? a / b : 0 });
  };
}

function load(model, id) {
  if (!loaded.has(model)) {
    const p = (async () => {
      if (model === ASSISTANT_MODEL) {
        const webgpu = await hasF16Gpu();
        return pipeline('text-generation', model, {
          device: webgpu ? 'webgpu' : 'wasm', dtype: webgpu ? ASSISTANT_DTYPE.webgpu : ASSISTANT_DTYPE.wasm, progress_callback: progressFor(id),
        });
      }
      return pipeline('translation', model, { device: 'wasm', dtype: 'q8', progress_callback: progressFor(id) });
    })();
    loaded.set(model, p);
    p.catch(() => loaded.delete(model)); // a failed download can be tried again
  }
  return loaded.get(model);
}

/** Sentences (and lines), at most 40, for the translator. */
function sentences(text) {
  const out = [];
  for (const line of text.split(/\n+/)) {
    out.push(...(line.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)]*|$)/g) || []).map((s) => s.trim()).filter(Boolean));
  }
  return out.length ? out.slice(0, 40) : [text];
}

self.onmessage = async ({ data: m }) => {
  const { id } = m;
  try {
    if (m.op === 'load') {
      for (const model of m.what === 'assistant' ? [ASSISTANT_MODEL] : m.what) await load(model, id);
      return self.postMessage({ id, ok: true });
    }
    if (m.op === 'translate') {
      // Opus-MT tends to drop everything after the first sentence, so each sentence goes on its own
      let parts = sentences(String(m.text).slice(0, 4000));
      for (const model of m.models) { // through English when there's no direct model
        const t = await load(model, id);
        // one at a time: batched (padded) input makes the decoder repeat itself
        const next = [];
        for (const s of parts) {
          const out = await t(s, { max_new_tokens: Math.min(256, 16 + s.length * 2) });
          next.push(out[0]?.translation_text ?? '');
        }
        parts = next;
      }
      return self.postMessage({ id, text: parts.join(' ').trim() });
    }
    if (m.op === 'generate') {
      const g = await load(ASSISTANT_MODEL, id);
      const out = await g(m.messages, { max_new_tokens: Math.min(400, m.maxTokens || 200), do_sample: false });
      const last = out[0]?.generated_text;
      const text = Array.isArray(last) ? last.at(-1)?.content ?? '' : String(last ?? '');
      return self.postMessage({ id, text });
    }
    self.postMessage({ id, error: 'unknown op' });
  } catch (e) {
    self.postMessage({ id, error: e?.message || String(e) });
  }
};
