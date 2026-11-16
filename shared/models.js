// The open models FabriC++ runs on the device where the browser has no built-in one (Firefox,
// Safari, mobile, Chrome without Gemini Nano). They run with Transformers.js (ONNX Runtime on
// WebGPU or WebAssembly) inside a worker. The relay serves the code and passes the model files
// through from the model source, caching them, and only for the models and files listed here.
// Pure data and functions, used by the relay, the page and the tests.

/** Opus-MT translation models that exist as ONNX ("from-to"; Japanese is "jap" on the English side). */
const OPUS_PAIRS = [
  'es-en', 'fr-en', 'de-en', 'it-en', 'ru-en', 'zh-en', 'ja-en', 'nl-en', 'ar-en', 'ko-en', 'hi-en',
  'tr-en', 'uk-en', 'pl-en', 'sv-en', 'vi-en', 'id-en',
  'en-es', 'en-fr', 'en-de', 'en-it', 'en-ru', 'en-zh', 'en-jap', 'en-nl', 'en-ar', 'en-hi', 'en-uk',
  'en-sv', 'en-vi', 'en-id',
];
const code = (c) => (c === 'jap' ? 'ja' : c);
const PAIRS = new Map(OPUS_PAIRS.map((p) => { const [a, b] = p.split('-'); return [`${code(a)}>${code(b)}`, `Xenova/opus-mt-${p}`]; }));

/** The small instruct model for summaries and suggested replies (multilingual, ~0.5 GB). */
export const ASSISTANT_MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';
/** WebGPU with 16-bit floats gets the 4-bit model; everything else the 8-bit one on WebAssembly. */
export const ASSISTANT_DTYPE = { webgpu: 'q4f16', wasm: 'q8' };
export const ASSISTANT_SIZE_MB = { webgpu: 483, wasm: 512 };
export const TRANSLATION_SIZE_MB = 113; // per language direction (8-bit encoder + decoder)

/** Languages a translation can start from or end in (through English when there's no direct model). */
export const TRANSLATION_LANGS = [...new Set([...PAIRS.keys()].flatMap((k) => k.split('>')))].sort();

/**
 * The models to run, in order, to translate `from` → `to`: [] when nothing to do, one model for a
 * direct pair, two through English, or null when there's no way.
 */
export function translationRoute(from, to) {
  if (!from || !to) return null;
  if (from === to) return [];
  const direct = PAIRS.get(`${from}>${to}`);
  if (direct) return [direct];
  const a = PAIRS.get(`${from}>en`);
  const b = PAIRS.get(`en>${to}`);
  return a && b ? [a, b] : null;
}

const COMMON_FILES = new Set([
  'config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json',
  'special_tokens_map.json', 'chat_template.jinja', 'chat_template.json',
]);
const FILES_BY_KIND = {
  translation: new Set(['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']),
  assistant: new Set(['onnx/model_q4f16.onnx', 'onnx/model_quantized.onnx']),
};

/** 'translation' | 'assistant' | null */
export function modelKind(id) {
  if (id === ASSISTANT_MODEL) return 'assistant';
  return [...PAIRS.values()].includes(id) ? 'translation' : null;
}

/** May the relay pass this model file through? (Only listed models, only the files they need.) */
export function allowedModelFile(id, file) {
  const kind = modelKind(id);
  if (!kind || typeof file !== 'string') return false;
  return COMMON_FILES.has(file) || FILES_BY_KIND[kind].has(file);
}
