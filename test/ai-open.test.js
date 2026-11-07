// On-device AI beyond Chrome: the open models (Transformers.js in a worker), the language
// detector for browsers without one, translation routes, and the relay passing model files
// through (only listed ones) and caching them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectLanguage } from '../shared/langdetect.js';
import { translationRoute, allowedModelFile, modelKind, ASSISTANT_MODEL, TRANSLATION_LANGS } from '../shared/models.js';
import { translateFrom } from '../shared/ai.js';
import { modelsFromEnv } from '../server/models.js';
import { createRelay } from '../server/relay.js';

const top = (t) => detectLanguage(t)[0];

test('language detection without a built-in detector', () => {
  const cases = {
    'Hola, ¿cómo estás? Nos vemos mañana': 'es',
    'Bonjour, comment ça va ? On se voit demain': 'fr',
    'Hallo, wie geht es dir? Wir sehen uns morgen': 'de',
    'Ciao, come stai? Ci vediamo domani': 'it',
    'Hey, how are you? See you tomorrow': 'en',
    'Hoi, hoe gaat het? Tot morgen': 'nl',
    'Merhaba, nasılsın? Yarın görüşürüz': 'tr',
    'Cześć, jak się masz? Do zobaczenia jutro': 'pl',
    'Xin chào, bạn có khỏe không? Hẹn gặp lại ngày mai': 'vi',
    'Привет, как дела? Увидимся завтра': 'ru',
    'Привіт, як справи? Побачимося завтра, їжак': 'uk',
    '你好，我们明天见': 'zh',
    'こんにちは、また明日ね': 'ja',
    '안녕하세요, 내일 봐요': 'ko',
    'مرحبا، كيف حالك؟': 'ar',
    'नमस्ते, आप कैसे हैं?': 'hi',
  };
  for (const [text, lang] of Object.entries(cases)) {
    const r = top(text);
    assert.equal(r.detectedLanguage, lang, text);
    // sure enough that the translation code acts on it
    assert.ok(translateFrom(detectLanguage(text), lang === 'en' ? 'de' : 'en', {}, text), `confident: ${text}`);
  }
  assert.equal(top('').detectedLanguage, 'und');
  assert.equal(top('12345 !!!').detectedLanguage, 'und');
  assert.equal(top('xyzzy plugh').detectedLanguage, 'und', 'no known words: unsure');
  assert.equal(translateFrom(detectLanguage('ok'), 'de', {}, 'ok'), null, 'too short to act on');
});

test('translation routes: direct, through English, or none', () => {
  assert.deepEqual(translationRoute('es', 'en'), ['Xenova/opus-mt-es-en']);
  assert.deepEqual(translationRoute('en', 'ja'), ['Xenova/opus-mt-en-jap']);
  assert.deepEqual(translationRoute('fr', 'de'), ['Xenova/opus-mt-fr-en', 'Xenova/opus-mt-en-de']);
  assert.deepEqual(translationRoute('de', 'de'), []);
  assert.equal(translationRoute('en', 'ko'), null, 'no English→Korean model');
  assert.equal(translationRoute('xx', 'en'), null);
  assert.ok(TRANSLATION_LANGS.includes('ja') && !TRANSLATION_LANGS.includes('jap'));

  assert.equal(modelKind('Xenova/opus-mt-es-en'), 'translation');
  assert.equal(modelKind(ASSISTANT_MODEL), 'assistant');
  assert.equal(modelKind('someone/else'), null);
  assert.ok(allowedModelFile('Xenova/opus-mt-es-en', 'onnx/decoder_model_merged_quantized.onnx'));
  assert.ok(allowedModelFile('Xenova/opus-mt-es-en', 'tokenizer.json'));
  assert.ok(!allowedModelFile('Xenova/opus-mt-es-en', 'onnx/decoder_model.onnx'), 'not the full-size weights');
  assert.ok(allowedModelFile(ASSISTANT_MODEL, 'onnx/model_q4f16.onnx'));
  assert.ok(!allowedModelFile(ASSISTANT_MODEL, 'onnx/model.onnx'));
  assert.ok(!allowedModelFile('evil/model', 'config.json'));
});

test('relay: model files passed through and cached, only listed ones; WebAssembly allowed, nothing else', async (t) => {
  assert.equal(modelsFromEnv({ FABRIC_MODELS: '0' }), null);
  assert.throws(() => modelsFromEnv({ FABRIC_MODEL_SOURCE: 'ftp://x' }), /http/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-models-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetched = [];
  const body = Buffer.alloc(300_000, 7);
  const fetchImpl = async (url, opts) => {
    fetched.push([url, opts.method]);
    if (url.endsWith('/missing.json')) return new Response('no', { status: 404 });
    if (opts.headers?.range) return new Response(body.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${body.length}` } });
    if (url.endsWith('config.json')) return new Response('{"model_type":"marian"}', { headers: { 'content-length': '23' } });
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  };
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, models: { source: 'https://models.example.test', dir }, modelFetch: fetchImpl });
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${relay.port}`;

  const page = await fetch(base + '/');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(csp, /connect-src 'self';/, 'models come from this origin only');
  assert.equal(page.headers.get('cross-origin-embedder-policy'), 'credentialless');
  assert.deepEqual(await (await fetch(base + '/api/models')).json(), { available: true });

  // the runtime comes from node_modules, through this origin
  const lib = await fetch(base + '/vendor/transformers.js');
  assert.equal(lib.status, 200);
  assert.match(lib.headers.get('content-type'), /javascript/);
  await lib.arrayBuffer();
  const wasm = await fetch(base + '/vendor/ort/ort-wasm-simd-threaded.asyncify.wasm');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  await wasm.arrayBuffer();
  assert.equal((await fetch(base + '/vendor/ort/../../package.json')).status, 404);

  const url = (m, f) => `${base}/models/${m}/resolve/main/${f}`;
  const onnx = url('Xenova/opus-mt-es-en', 'onnx/encoder_model_quantized.onnx');
  const first = await fetch(onnx);
  assert.equal(first.status, 200);
  assert.equal(Buffer.from(await first.arrayBuffer()).length, body.length);
  assert.deepEqual(fetched[0], ['https://models.example.test/Xenova/opus-mt-es-en/resolve/main/onnx/encoder_model_quantized.onnx', 'GET']);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(path.join(dir, 'Xenova/opus-mt-es-en/onnx/encoder_model_quantized.onnx')), 'cached on disk');
  const again = await fetch(onnx);
  assert.equal(Buffer.from(await again.arrayBuffer()).length, body.length);
  assert.equal(fetched.length, 1, 'second device served from the cache');
  assert.match(again.headers.get('cache-control'), /immutable/);

  // the size probe Transformers.js sends first: answered from the cache, or passed through (not cached)
  const probe = await fetch(onnx, { headers: { range: 'bytes=0-0' } });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get('content-range'), `bytes 0-0/${body.length}`);
  assert.equal((await probe.arrayBuffer()).byteLength, 1);
  const mid = await fetch(onnx, { headers: { range: 'bytes=10-19' } });
  assert.equal(mid.status, 206);
  assert.equal((await mid.arrayBuffer()).byteLength, 10);
  assert.equal((await fetch(onnx, { headers: { range: `bytes=${body.length}-` } })).status, 416);
  const decoder = url('Xenova/opus-mt-es-en', 'onnx/decoder_model_merged_quantized.onnx');
  const remote = await fetch(decoder, { headers: { range: 'bytes=0-0' } });
  assert.equal(remote.status, 206);
  assert.equal(remote.headers.get('content-range'), `bytes 0-0/${body.length}`);
  assert.equal((await remote.arrayBuffer()).byteLength, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'Xenova/opus-mt-es-en/onnx/decoder_model_merged_quantized.onnx')), 'a probe caches nothing');
  assert.equal(fetched.length, 2, 'one upstream request for the probe');
  fetched.pop();
  assert.equal((await (await fetch(url('Xenova/opus-mt-es-en', 'config.json'))).json()).model_type, 'marian');
  assert.equal((await fetch(url('Xenova/opus-mt-es-en', 'onnx/decoder_model.onnx'))).status, 404, 'unlisted file');
  assert.equal((await fetch(url('someone/else', 'config.json'))).status, 404, 'unlisted model');
  assert.equal((await fetch(`${base}/models/Xenova/opus-mt-es-en/resolve/main/..%2F..%2Fsecret`)).status, 404);
  assert.equal((await fetch(`${base}/models/Xenova/opus-mt-es-en/resolve/v1/config.json`)).status, 404, 'main only');
  assert.equal(fetched.length, 2, 'refused requests never reach the source');

  const off = await createRelay({ port: 0, dataFile: null, log: () => {}, models: null });
  t.after(() => off.close());
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${off.port}/api/models`)).json(), { available: false });
  assert.equal((await fetch(`http://127.0.0.1:${off.port}/models/Xenova/opus-mt-es-en/resolve/main/config.json`)).status, 404);
});
