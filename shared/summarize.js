// On-device thread summary (extractive, no network). Placeholder for the local model:
// picks the most informative messages by term frequency and pulls out open questions.

const STOP = new Set(('a an and are as at be but by can do for from has have i if in is it its just me my no not of ' +
  'on or our so that the their them then there these they this to too up us was we were what when will with you your ' +
  'yes ok okay im its thats dont lets get got hey hi hello thanks thank').split(' '));

const words = (t) => t.toLowerCase().match(/[a-z0-9']+/g)?.map((w) => w.replace(/'/g, '')).filter((w) => w.length > 2 && !STOP.has(w)) || [];

export function summarize(messages, { me, max = 3 } = {}) {
  const msgs = messages.filter((m) => m.text?.trim());
  if (!msgs.length) return ['No messages to summarize yet.'];
  const freq = new Map();
  for (const m of msgs) for (const w of new Set(words(m.text))) freq.set(w, (freq.get(w) || 0) + 1);

  const scored = msgs.map((m, i) => {
    const ws = words(m.text);
    const score = ws.length ? ws.reduce((s, w) => s + (freq.get(w) || 0), 0) / Math.sqrt(ws.length) : 0;
    return { m, i, score };
  });
  const top = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.i - b.i);
  const who = (m) => (m.from === me ? 'You' : m.from);
  const clip = (t) => (t.length > 140 ? t.slice(0, 137) + '…' : t);

  const lines = top.map(({ m }) => `${who(m)}: ${clip(m.text)}`);
  const lastQ = [...msgs].reverse().find((m) => m.text.trim().endsWith('?'));
  if (lastQ && lastQ.from !== me && msgs.at(-1) === lastQ) lines.push(`Open question for you: ${clip(lastQ.text)}`);
  const keyTerms = [...freq.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
  if (keyTerms.length) lines.push(`Topics: ${keyTerms.join(', ')}`);
  lines.unshift(`${msgs.length} message${msgs.length === 1 ? '' : 's'}.`);
  return lines;
}
