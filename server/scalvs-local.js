// Scalvs AI tasks on an open model, on the relay host: no API key, and the message never leaves the
// machine, so AI tasks stay end-to-end encrypted to Scalvs like built-in ones.
//
// The model is the same small open instruct model the app runs on devices (shared/models.js,
// Qwen2.5-0.5B-Instruct, Apache-2.0), in its unsigned 8-bit build: the signed 8-bit build the
// browser uses produces nonsense on ONNX Runtime's CPU backend in Node. Files are fetched once into
// the relay's model cache (FABRIC_MODEL_DIR) with resumable downloads, then loaded from disk only.
// It answers simple tasks (short drafts, rewording, one-line facts); for more, set an Anthropic key.

import fs from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { ASSISTANT_MODEL } from '../shared/models.js';
import { nodeFetch } from './models.js';

export const LOCAL_FILES = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_uint8.onnx'];
const HISTORY_TURNS = 3;          // user+assistant pairs remembered per chat (a small model loses the thread fast)
const HISTORY_IDLE_MS = 3600_000;
const MAX_NEW_TOKENS = 300;

const SYSTEM = 'You are Scalvs, a task assistant inside the FabriC++ messenger. Do the task the person texts you. '
  + 'Reply in plain text, briefly. If you are not sure of a fact, say so.';

export function localAiFromEnv(env = process.env, root = '.') {
  if (env.FABRIC_SCALVS_LOCAL === '0') return null;
  return {
    local: true,
    dir: env.FABRIC_MODEL_DIR || path.join(root, 'data', 'models'),
    source: (env.FABRIC_MODEL_SOURCE || 'https://huggingface.co').replace(/\/$/, ''),
    dailyPerUser: Math.max(1, Number(env.FABRIC_SCALVS_AI_DAILY) || 50),
  };
}

/**
 * Download whatever model files are missing, resuming a file cut off part-way (Range requests).
 * Returns the number of files fetched.
 */
export async function ensureModelFiles({ dir, source, model = ASSISTANT_MODEL, files = LOCAL_FILES, fetchImpl = nodeFetch, tries = 8, log = () => {} }) {
  let fetched = 0;
  for (const file of files) {
    const dest = path.join(dir, model, file);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const url = `${source}/${model}/resolve/main/${file}`;
    for (let attempt = 1; ; attempt++) {
      const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      try {
        const res = await fetchImpl(url, { headers: have ? { range: `bytes=${have}-` } : {} });
        if (res.status === 416) break; // already complete
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const resumed = res.status === 206;
        await streamPipeline(res.body, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
        const want = Number(res.headers.get('content-length') || 0) + (resumed ? have : 0);
        if (want && fs.statSync(part).size !== want) throw new Error('download cut short');
        break;
      } catch (e) {
        if (attempt >= tries) throw new Error(`could not download ${file}: ${e.message}`);
        log(`[scalvs] model download interrupted (${e.message}); resuming`);
        await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** attempt)));
      }
    }
    fs.renameSync(part, dest);
    fetched++;
  }
  return fetched;
}

/** Load the tokenizer and model from disk; returns generate(messages) → text. */
async function loadGenerator({ dir, model = ASSISTANT_MODEL }) {
  const { AutoTokenizer, AutoModelForCausalLM, env } = await import('@huggingface/transformers');
  env.localModelPath = dir;
  env.allowLocalModels = true;
  env.allowRemoteModels = false; // files come from ensureModelFiles, never fetched behind our back
  const tok = await AutoTokenizer.from_pretrained(model);
  const lm = await AutoModelForCausalLM.from_pretrained(model, { dtype: 'uint8', device: 'cpu' });
  return async (messages) => {
    const inputs = tok.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true });
    const out = await lm.generate({ ...inputs, max_new_tokens: MAX_NEW_TOKENS, do_sample: false, repetition_penalty: 1.1 });
    const n = inputs.input_ids.dims.at(-1);
    return tok.decode(out.slice(null, [n, null])[0], { skip_special_tokens: true }).trim();
  };
}

/**
 * Same shape as createAi in scalvs-ai.js: { ask(handle, text), warm(), note, model }.
 * `generate` replaces the real model (tests).
 */
export function createLocalAi({ dir, source, dailyPerUser = 50, generate = null, fetchImpl, log = console.log, now = Date.now }) {
  let ready = generate ? Promise.resolve(generate) : null;
  let queue = Promise.resolve(); // one generation at a time: they share the CPU
  const chats = new Map();
  const used = new Map();

  function warm() {
    ready ??= (async () => {
      const t = now();
      const n = await ensureModelFiles({ dir, source, fetchImpl, log });
      if (n) log(`[scalvs] downloaded the open model (${n} files)`);
      const g = await loadGenerator({ dir });
      log(`[scalvs] open model ready in ${Math.round((now() - t) / 1000)}s`);
      return g;
    })();
    ready.catch((e) => { log(`[scalvs] open model unavailable: ${e.message}`); ready = null; }); // try again on the next task
    return ready;
  }

  function quota(handle) {
    const day = new Date(now()).toISOString().slice(0, 10);
    const u = used.get(handle);
    if (!u || u.day !== day) { used.set(handle, { day, n: 1 }); return true; }
    if (u.n >= dailyPerUser) return false;
    u.n++;
    return true;
  }

  async function ask(handle, text) {
    if (!quota(handle)) throw Object.assign(new Error('quota'), { userMessage: `You've used today's ${dailyPerUser} AI tasks. Built-in tasks still work; AI tasks reset at midnight UTC.` });
    let g;
    try { g = await warm(); } catch {
      throw Object.assign(new Error('model unavailable'), { userMessage: 'My AI model is still downloading or failed to load. Built-in tasks work meanwhile; try again in a few minutes.' });
    }
    let chat = chats.get(handle);
    if (!chat || now() - chat.at > HISTORY_IDLE_MS) chat = { at: now(), turns: [] };
    const messages = [{ role: 'system', content: SYSTEM }, ...chat.turns, { role: 'user', content: text }];
    const run = queue.then(() => g(messages));
    queue = run.catch(() => {});
    const reply = (await run) || 'I had nothing useful to say to that. Try rephrasing the task.';
    chat.turns = [...chat.turns, { role: 'user', content: text }, { role: 'assistant', content: reply }].slice(-HISTORY_TURNS * 2);
    chat.at = now();
    chats.set(handle, chat);
    return reply;
  }

  return {
    ask, warm, model: ASSISTANT_MODEL,
    note: 'AI tasks run on an open model on this relay\'s own machine: nothing leaves it, so they stay end-to-end encrypted to Scalvs. It handles short, simple tasks.',
  };
}
