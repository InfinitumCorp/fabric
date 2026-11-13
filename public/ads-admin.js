// Operator page for sponsored-post campaigns (talks to /api/ads/campaigns on this relay).
import { TOPICS } from '/shared/spaces.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let token = sessionStorage.getItem('fabric-op') || '';

async function api(path, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(path, { method, body: body && JSON.stringify(body), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

for (const t of TOPICS) {
  const l = el('label', 'ad-topic');
  const i = el('input'); i.type = 'checkbox'; i.value = t;
  l.append(i, document.createTextNode(` ${t}`));
  $('topic-boxes').append(l);
}
const form = $('new');
const syncForm = () => {
  $('topics').classList.toggle('hidden', form.placement.value !== 'channel');
  $('pv-adv').textContent = form.advertiser.value || 'Advertiser';
  $('pv-head').textContent = form.headline.value || 'Headline';
  $('pv-body').textContent = form.body.value;
  $('pv-cta').textContent = `${form.cta.value || 'Learn more'} ↗`;
};
form.addEventListener('input', syncForm);
syncForm();

form.onsubmit = async (e) => {
  e.preventDefault();
  $('new-err').textContent = '';
  const v = (n) => form[n].value.trim();
  try {
    await api('/api/ads/campaigns', {
      name: v('name'), advertiser: v('advertiser'), headline: v('headline'), body: v('body'), url: v('url'), cta: v('cta') || undefined,
      placement: v('placement'), topics: v('placement') === 'channel' ? [...$('topic-boxes').querySelectorAll('input:checked')].map((i) => i.value) : [],
      freqCap: Number(v('freqCap') || 3), maxImpressions: v('maxImpressions') ? Number(v('maxImpressions')) : null,
      endsAt: v('endsAt') ? new Date(`${v('endsAt')}T23:59:59Z`).getTime() : null, status: form.active.checked ? 'active' : 'paused',
    });
    form.reset(); syncForm();
    load();
  } catch (err) { $('new-err').textContent = err.message; }
};

async function load() {
  $('list-err').textContent = '';
  const rows = $('rows'); rows.replaceChildren();
  let list;
  try { list = (await api('/api/ads/campaigns')).campaigns; } catch (e) { $('list-err').textContent = e.message; return; }
  if (!list.length) { const tr = el('tr'); const td = el('td', 'muted', 'No campaigns yet.'); td.colSpan = 6; tr.append(td); rows.append(tr); }
  for (const c of list) {
    const tr = el('tr');
    const name = el('td'); name.append(el('strong', '', c.name), el('div', 'muted small', `${c.advertiser} · ${c.headline}`));
    const place = c.placement === 'chatlist' ? 'Chat list' : `Channels${c.topics.length ? `: ${c.topics.join(', ')}` : ' (any topic)'}`;
    const act = el('td');
    const toggle = el('button', 'ghost small', c.status === 'active' ? 'Pause' : 'Start');
    toggle.type = 'button';
    toggle.onclick = async () => { try { await api(`/api/ads/campaigns/${c.id}`, { status: c.status === 'active' ? 'paused' : 'active' }, 'PATCH'); load(); } catch (e) { $('list-err').textContent = e.message; } };
    act.append(toggle);
    tr.append(name, el('td', 'small', place), el('td', `small ad-${c.status}`, c.status), el('td', '', `${c.impressions.toLocaleString('en-US')}${c.maxImpressions ? ` / ${c.maxImpressions.toLocaleString('en-US')}` : ''}`),
      el('td', '', `${c.clicks.toLocaleString('en-US')}${c.impressions ? ` (${((c.clicks / c.impressions) * 100).toFixed(1)}%)` : ''}`), act);
    rows.append(tr);
  }
}
$('tok').onsubmit = (e) => { e.preventDefault(); token = $('tok-in').value.trim(); if (token) sessionStorage.setItem('fabric-op', token); else sessionStorage.removeItem('fabric-op'); load(); };
load();
