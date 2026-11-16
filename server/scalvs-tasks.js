// Scalvs task engine: turns one chat message into one reply.
//
// Scalvs is SCALVS.ai (Infinitum's AI workforce) reachable as the contact +scalvs.veil. Built-in tasks
// run here with no network; anything else goes to the AI hook (Claude, see server/scalvs-ai.js) when
// the relay has one. Pure apart from the hooks passed in, so it is tested without a relay.

import { randomInt, randomUUID } from 'node:crypto';

export const MAX_INPUT = 4000;  // characters of a message Scalvs reads
export const MAX_REPLY = 4000;  // characters Scalvs sends back
export const MAX_REMINDERS = 10; // pending reminders per account
export const MAX_REMIND_MS = 7 * 24 * 3600 * 1000;

export const HELP = [
  'Scalvs (SCALVS.ai) runs tasks for you. Send one of these:',
  '• calc 2*(3+4)^2: arithmetic (or just send the sum)',
  '• time, or time Europe/Berlin',
  '• remind me in 20m to call Ana (s, m, h or d; up to 7 days)',
  '• reminders: list them; cancel reminders: clear them',
  '• roll 2d6 · uuid · password 20 · ping',
  '• help: this list',
];
export const AI_HELP = '• anything else: an AI task (write, summarise, translate, plan, explain)';
export const AI_NOTE = 'AI tasks leave end-to-end encryption: Scalvs sends that message to Anthropic\'s API to answer it. Built-in tasks never leave this relay.';

// ---------- calculator: a small recursive-descent parser, never eval ----------
const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, ln: Math.log, log: Math.log10, exp: Math.exp,
};
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(src) {
  const out = [];
  const re = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([a-z]+)|(\*\*|[-+*/%^(),×÷]))/gy;
  let m;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    m = re.exec(src);
    if (!m) { if (/^\s*$/.test(src.slice(pos))) break; throw new Error('bad input'); }
    pos = re.lastIndex;
    if (m[1]) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2]) out.push({ t: 'id', v: m[2] });
    else out.push({ t: 'op', v: ({ '**': '^', '×': '*', '÷': '/' })[m[3]] || m[3] });
  }
  return out;
}

/** Evaluate an arithmetic expression. Throws on anything that isn't one. */
export function calc(src) {
  const s = String(src).toLowerCase().replace(/,(?=\d{3}\b)/g, ''); // 1,000 → 1000
  if (s.length > 200) throw new Error('too long');
  const toks = tokenize(s);
  if (!toks.length) throw new Error('empty');
  let i = 0;
  const peek = () => toks[i];
  const eat = (v) => { if (peek()?.v === v) { i++; return true; } return false; };
  let depth = 0;
  function expr() {
    let v = term();
    for (;;) {
      if (eat('+')) v += term();
      else if (eat('-')) v -= term();
      else return v;
    }
  }
  function term() {
    let v = unary();
    for (;;) {
      if (eat('*')) v *= unary();
      else if (eat('/')) v /= unary();
      else if (eat('%')) v %= unary();
      else return v;
    }
  }
  function unary() {
    if (eat('-')) return -unary();
    if (eat('+')) return unary();
    return power();
  }
  function power() {
    const base = atom();
    return eat('^') ? base ** unary() : base; // right-associative
  }
  function atom() {
    if (++depth > 100) throw new Error('too deep');
    try {
      const tk = toks[i++];
      if (!tk) throw new Error('unexpected end');
      if (tk.t === 'num') return tk.v;
      if (tk.t === 'id') {
        if (tk.v in CONSTS) return CONSTS[tk.v];
        const f = FUNCS[tk.v];
        if (!f || !eat('(')) throw new Error(`unknown ${tk.v}`);
        const v = expr();
        if (!eat(')')) throw new Error('missing )');
        return f(v);
      }
      if (tk.v === '(') {
        const v = expr();
        if (!eat(')')) throw new Error('missing )');
        return v;
      }
      throw new Error(`unexpected ${tk.v}`);
    } finally { depth--; }
  }
  const v = expr();
  if (i !== toks.length) throw new Error('bad input');
  if (!Number.isFinite(v)) throw new Error('not a finite number');
  return v;
}

export const fmtNumber = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12))));

// something that is only numbers and operators reads as a sum, not as a question for the AI
const LOOKS_LIKE_SUM = /^[\d\s.+\-*/%^()×÷,]+$/;

// ---------- durations and reminders ----------
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const UNIT_WORDS = { sec: 's', secs: 's', second: 's', seconds: 's', min: 'm', mins: 'm', minute: 'm', minutes: 'm', hr: 'h', hrs: 'h', hour: 'h', hours: 'h', day: 'd', days: 'd' };

/** '20m', '2 hours', '1h30m' → milliseconds, or null. */
export function parseDuration(text) {
  const re = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])(?![a-z])/gy;
  const s = String(text).trim().toLowerCase();
  let ms = 0;
  let pos = 0;
  let m;
  while (pos < s.length) {
    re.lastIndex = pos;
    m = re.exec(s);
    if (!m) break;
    ms += Number(m[1]) * UNIT_MS[UNIT_WORDS[m[2]] || m[2]];
    pos = re.lastIndex;
    while (s[pos] === ' ' || s[pos] === ',') pos++;
    if (s.startsWith('and ', pos)) pos += 4;
  }
  return ms > 0 && pos > 0 ? { ms, rest: s.slice(pos).trim() } : null;
}

export function fmtDuration(ms) {
  const parts = [];
  for (const [u, n] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]]) {
    if (ms >= n) { parts.push(`${Math.floor(ms / n)}${u}`); ms %= n; }
  }
  return parts.join(' ') || '0s';
}

// ---------- the dispatcher ----------
const clean = (s, max) => String(s ?? '')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '') // controls and bidi overrides
  .slice(0, max);

/**
 * Run one task.
 * @param {string} input   the message text
 * @param {object} ctx
 * @param {string} ctx.handle       who asked (@name.veil)
 * @param {number} [ctx.now]        clock, for tests
 * @param {object} ctx.reminders    { add(at, text) → count, list() → [{at,text}], clear() → count }
 * @param {((text) => Promise<string>)|null} [ctx.ai]  AI task hook, or null when the relay has none
 * @param {string} [ctx.aiNote]     where AI tasks go, for help (defaults to AI_NOTE, the Anthropic API)
 * @returns {Promise<{ reply: string, kind: string }>} kind says which task ran (usage metering, tests)
 */
export async function runTask(input, ctx) {
  const now = ctx.now ?? Date.now();
  const text = clean(input, MAX_INPUT).trim();
  const out = (reply, kind) => ({ reply: clean(reply, MAX_REPLY), kind });
  if (!text) return out('Send help to see what I can do.', 'empty');
  const cmd = text.replace(/^[/!]/, '');
  const lower = cmd.toLowerCase();
  const word = lower.split(/\s+/)[0];
  const arg = cmd.slice(word.length).trim();

  if (['help', 'start', 'menu', '?', 'commands'].includes(lower)) {
    return out([...HELP, ...(ctx.ai ? [AI_HELP, '', ctx.aiNote || AI_NOTE] : [])].join('\n'), 'help');
  }
  if (lower === 'ping') return out('pong', 'ping');
  if (word === 'calc' || word === 'calculate' || LOOKS_LIKE_SUM.test(cmd)) {
    const exprText = word === 'calc' || word === 'calculate' ? arg : cmd;
    try {
      return out(`${exprText.replace(/\s+/g, ' ')} = ${fmtNumber(calc(exprText))}`, 'calc');
    } catch (e) {
      return out(`I couldn't calculate that (${e.message}). Try: calc 2*(3+4)`, 'calc');
    }
  }
  if (word === 'time' || word === 'date' || lower === 'what time is it') {
    const zone = word === 'time' || word === 'date' ? arg : '';
    try {
      const f = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'long', timeZone: zone || 'UTC' });
      return out(f.format(new Date(now)), 'time');
    } catch {
      return out(`I don't know the time zone "${zone}". Try one like Europe/Berlin or America/New_York.`, 'time');
    }
  }
  if (word === 'roll') {
    const m = /^(\d{0,2})d(\d{1,4})$/.exec(arg.toLowerCase() || 'd6');
    const n = m ? Number(m[1] || 1) : 0;
    const sides = m ? Number(m[2]) : 0;
    if (!m || n < 1 || n > 20 || sides < 2 || sides > 1000) return out('Try roll 2d6 (up to 20 dice, 2 to 1000 sides).', 'roll');
    const rolls = Array.from({ length: n }, () => randomInt(1, sides + 1));
    return out(n === 1 ? `🎲 ${rolls[0]}` : `🎲 ${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b, 0)}`, 'roll');
  }
  if (lower === 'uuid') return out(randomUUID(), 'uuid');
  if (word === 'password') {
    const len = arg ? Number(arg) : 20;
    if (!Number.isInteger(len) || len < 8 || len > 64) return out('Try password 20 (8 to 64 characters).', 'password');
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
    return out(Array.from({ length: len }, () => chars[randomInt(chars.length)]).join(''), 'password');
  }
  if (lower === 'reminders' || lower === 'list reminders') {
    const list = ctx.reminders.list();
    if (!list.length) return out('No reminders set.', 'reminders');
    return out(list.map((r) => `• in ${fmtDuration(r.at - now)}: ${r.text}`).join('\n'), 'reminders');
  }
  if (lower === 'cancel reminders' || lower === 'clear reminders') {
    const n = ctx.reminders.clear();
    return out(n ? `Cancelled ${n} reminder${n === 1 ? '' : 's'}.` : 'No reminders to cancel.', 'reminders');
  }
  if (word === 'remind') {
    // remind me in 20m to call Ana · remind 2h stretch · remind me in 1 hour that the oven is on
    const rest = arg.replace(/^me\s+/i, '').replace(/^in\s+/i, '');
    const d = parseDuration(rest);
    if (!d) return out('Try: remind me in 20m to call Ana', 'remind');
    if (d.ms > MAX_REMIND_MS) return out('I can remind you up to 7 days ahead.', 'remind');
    const what = rest.slice(rest.length - d.rest.length).replace(/^(to|that|about)\s+/i, '').trim() || 'Reminder';
    if (ctx.reminders.list().length >= MAX_REMINDERS) return out(`You already have ${MAX_REMINDERS} reminders. Send cancel reminders to clear them.`, 'remind');
    ctx.reminders.add(now + d.ms, what.slice(0, 500));
    return out(`OK, in ${fmtDuration(d.ms)} I'll remind you: ${what.slice(0, 500)}`, 'remind');
  }

  if (!ctx.ai) {
    return out(`I don't know that task yet, and AI tasks are off on this relay.\n\n${HELP.join('\n')}`, 'unknown');
  }
  try {
    return out(await ctx.ai(text), 'ai');
  } catch (e) {
    return out(e.userMessage || 'The AI task failed. Please try again in a minute.', 'ai_error');
  }
}
