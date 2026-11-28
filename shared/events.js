// Events in chats: a message that carries an `event` field ({ title, start, end?, place?, note? },
// times in milliseconds since 1970 UTC). Anyone in the chat answers with an `rsvp` action
// (going: 'yes' | 'maybe' | 'no', or '' to take the answer back); the author can `cancel` it.
// Everything travels inside the end-to-end encryption like any other message. Older clients show
// the plain-text fallback.

export const MAX_EVENT_TITLE = 120;
export const MAX_EVENT_PLACE = 120;
export const MAX_EVENT_NOTE = 500;
export const MAX_EVENT_SPAN = 30 * 86400_000; // an event lasts at most 30 days
export const RSVP = ['yes', 'maybe', 'no'];
export const RSVP_LABEL = { yes: 'Going', maybe: 'Maybe', no: 'Can’t go' };

const clip = (s, n) => String(s ?? '').slice(0, n).trim();
const MIN_TS = Date.UTC(2000, 0, 1);
const MAX_TS = Date.UTC(2200, 0, 1);
const isTs = (t) => Number.isInteger(t) && t >= MIN_TS && t < MAX_TS;

/** An event carried by a message, checked and trimmed; null when absent or malformed. */
export function eventOf(payload) {
  const e = payload?.event;
  if (!e || typeof e !== 'object') return null;
  const title = clip(e.title, MAX_EVENT_TITLE);
  if (!title || !isTs(e.start)) return null;
  const out = { title, start: e.start };
  if (e.end !== undefined) {
    if (!isTs(e.end) || e.end <= e.start || e.end - e.start > MAX_EVENT_SPAN) return null;
    out.end = e.end;
  }
  const place = clip(e.place, MAX_EVENT_PLACE);
  if (place) out.place = place;
  const note = clip(e.note, MAX_EVENT_NOTE);
  if (note) out.note = note;
  return out;
}

/** "Wed, 12 Nov 2026, 18:00 – 20:00" in the reader's own time zone and language. */
export function eventWhen(ev, locale = undefined, timeZone = undefined) {
  const opt = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) };
  const start = new Date(ev.start).toLocaleString(locale, opt);
  if (!ev.end) return start;
  const sameDay = new Date(ev.start).toLocaleDateString(locale, timeZone ? { timeZone } : {}) === new Date(ev.end).toLocaleDateString(locale, timeZone ? { timeZone } : {});
  const end = sameDay
    ? new Date(ev.end).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) })
    : new Date(ev.end).toLocaleString(locale, opt);
  return `${start} – ${end}`;
}

/** The text older clients show for an event (UTC, so it means the same thing everywhere). */
export function eventFallback(ev) {
  const lines = [`📅 ${ev.title}`, `${eventWhen(ev, 'en-GB', 'UTC')} UTC`];
  if (ev.place) lines.push(`📍 ${ev.place}`);
  if (ev.note) lines.push(ev.note);
  lines.push('(An event: update FabriC++ to reply.)');
  return lines.join('\n');
}

/** Answers counted for display: { yes, maybe, no, mine }. */
export function rsvpSummary(m, me) {
  const out = { yes: 0, maybe: 0, no: 0, mine: m?.rsvp?.[me] || '' };
  for (const v of Object.values(m?.rsvp || {})) if (RSVP.includes(v)) out[v]++;
  return out;
}

/** Who answered what: { yes: [handles], maybe: [...], no: [...] }, each sorted. */
export function rsvpLists(m) {
  const out = { yes: [], maybe: [], no: [] };
  for (const [who, v] of Object.entries(m?.rsvp || {})) if (RSVP.includes(v)) out[v].push(who);
  for (const k of RSVP) out[k].sort();
  return out;
}

/** Apply an rsvp from `actor`. Returns true when the message changed. */
export function applyRsvp(m, actor, going) {
  if (!m || m.deleted || !m.event || m.evCancelled) return false;
  if (going !== '' && !RSVP.includes(going)) return false;
  m.rsvp ??= {};
  if (going === '') delete m.rsvp[actor]; else m.rsvp[actor] = going;
  if (!Object.keys(m.rsvp).length) delete m.rsvp;
  return true;
}

const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsTime = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Fold long lines at 74 octets-ish (RFC 5545 says 75 octets; characters are close enough here). */
const fold = (line) => line.length <= 74 ? line : line.match(/.{1,73}/gu).join('\r\n ');

/** An iCalendar file for "Add to calendar". */
export function eventIcs(ev, uid, now = Date.now()) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Infinitum//FabriC++//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${String(uid).replace(/[^A-Za-z0-9_-]/g, '')}@infinitumfabric.app`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(ev.start)}`,
    `DTEND:${icsTime(ev.end || ev.start + 3600_000)}`,
    `SUMMARY:${icsText(ev.title)}`,
    ...(ev.place ? [`LOCATION:${icsText(ev.place)}`] : []),
    ...(ev.note ? [`DESCRIPTION:${icsText(ev.note)}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Value for an <input type="datetime-local"> in the device's time zone. */
export function toLocalInput(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
