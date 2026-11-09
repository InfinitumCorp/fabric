// Scalvs AI tasks: one Claude call per message, with the last few turns of that chat as context.
//
// Only messages that aren't a built-in task get here, and only when the relay operator turned AI
// tasks on (FABRIC_SCALVS_AI_KEY or ANTHROPIC_API_KEY). Those messages leave end-to-end encryption:
// Scalvs says so in its help. History is kept in memory only, never on disk.

import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const HISTORY_TURNS = 8;         // user+assistant pairs remembered per chat
const HISTORY_IDLE_MS = 3600_000; // forget a chat's context after an hour of silence

const SYSTEM = [
  'You are Scalvs, the SCALVS.ai task agent, reached as the contact +scalvs.veil inside the FabriC++ messenger.',
  'People text you tasks: writing, summarising, translating, planning, explaining, drafting replies, quick research from what you know.',
  'Do the task and reply in the chat. Plain text only: no markdown headings, tables or code fences unless the person asks for code.',
  'Keep replies short enough to read on a phone; use a short list when it helps.',
  'You cannot browse, send messages to other people, make calls or take actions outside this chat. If a task needs that, say so in one line and offer what you can do instead.',
  'Built-in commands the person can also send: help, calc, time, remind, reminders, roll, uuid, password.',
].join('\n');

export function aiFromEnv(env = process.env) {
  if (env.FABRIC_SCALVS_AI === '0') return null;
  const apiKey = env.FABRIC_SCALVS_AI_KEY || env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    model: env.FABRIC_SCALVS_MODEL || DEFAULT_MODEL,
    dailyPerUser: Math.max(1, Number(env.FABRIC_SCALVS_AI_DAILY) || 50),
  };
}

/**
 * @param {object} cfg  { apiKey, model, dailyPerUser } or { client } (tests pass a stub client)
 * @returns {{ ask(handle, text): Promise<string>, forget(handle): void }}
 */
export function createAi({ apiKey, model = DEFAULT_MODEL, dailyPerUser = 50, client = null, log = console.log, now = Date.now }) {
  const anthropic = client || new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  const chats = new Map(); // handle -> { at, messages: MessageParam[] }
  const used = new Map();  // handle -> { day, n }

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
    let chat = chats.get(handle);
    if (!chat || now() - chat.at > HISTORY_IDLE_MS) chat = { at: now(), messages: [] };
    const messages = [...chat.messages, { role: 'user', content: text }];
    let response;
    try {
      response = await anthropic.beta.messages.create({
        model,
        max_tokens: 4000,
        system: SYSTEM,
        output_config: { effort: 'low' }, // chat-sized tasks; Opus 5.5 defaults to medium
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default', // a safety decline is retried on a suitable model instead of failing
        messages,
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw Object.assign(e, { userMessage: 'Scalvs is busy right now. Try again in a minute.' });
      if (e instanceof Anthropic.AuthenticationError) log('[scalvs] AI key rejected; check FABRIC_SCALVS_AI_KEY');
      else if (e instanceof Anthropic.APIError) log(`[scalvs] AI error ${e.status}`);
      else log(`[scalvs] AI unreachable: ${e.message}`);
      throw e;
    }
    if (response.stop_reason === 'refusal') {
      return "I can't help with that one. Send help to see what else I can do.";
    }
    const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
      || 'I had nothing useful to say to that. Try rephrasing the task.';
    // Append-only: the next request resends this turn's content unchanged (thinking blocks
    // included), because edited history invalidates them. When the chat gets long it starts over
    // rather than trimming its oldest turns.
    const next = [...messages, { role: 'assistant', content: response.content }];
    chat.messages = next.length > HISTORY_TURNS * 2 ? [] : next;
    chat.at = now();
    chats.set(handle, chat);
    return reply;
  }

  return { ask, forget: (handle) => chats.delete(handle), model };
}
