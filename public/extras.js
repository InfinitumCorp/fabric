// Events, stickers and Favourites in the web client (and so the desktop and Android apps).
// Pure logic lives in /shared/events.js; the event and sticker fields ride on ordinary end-to-end
// encrypted messages, and RSVPs are actions like votes on a poll. Favourites is a local chat
// preference shown as a built-in folder.
import { eventFallback, eventWhen, eventIcs, rsvpSummary, rsvpLists, toLocalInput, RSVP, RSVP_LABEL, MAX_EVENT_TITLE, MAX_EVENT_PLACE, MAX_EVENT_NOTE, MAX_EVENT_SPAN } from '/shared/events.js';

export const MAX_STICKERS = 40;
const STICKER_PX = 320;
const STICKER_BYTES = 100_000;

export function installExtras(api) {
  const { $, el, toast } = api;
  const db = () => api.db();
  const active = () => api.active();
  const me = () => db()?.handle;
  const short = (h) => h === me() ? 'You' : h.replace(/^@/, '').replace(/\.veil$/, '');

  // ---------- small UI kit (same house style as wa.js) ----------
  function dialog(title, cls = '') {
    const d = el('dialog', 'fwd-dialog desk-dialog ' + cls);
    d.setAttribute('aria-label', title);
    d.append(el('h3', '', title));
    d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    document.body.append(d);
    return d;
  }
  function button(text, cls, onclick) { const b = el('button', cls, text); b.type = 'button'; if (onclick) b.onclick = onclick; return b; }
  function actions(...btns) { const r = el('div', 'dialog-actions'); r.append(...btns); return r; }
  function field(label, input) { const l = el('label', 'field'); l.append(el('span', '', label), input); return l; }
  function input(type, max) { const i = el('input', 'text-input'); i.type = type; if (max) i.maxLength = max; return i; }
  function menuItem(id, text, onclick) { const b = button(text, '', onclick); b.id = id; b.setAttribute('role', 'menuitem'); return b; }
  const download = (name, text, type) => {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  };

  // ---------- events ----------
  function openEvent(to = active()) {
    if (!to) return;
    const d = dialog('New event');
    const title = input('text', MAX_EVENT_TITLE); title.placeholder = 'Dinner at ours'; title.id = 'ev-title';
    const next = new Date(); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
    const start = input('datetime-local'); start.value = toLocalInput(next); start.id = 'ev-start';
    const end = input('datetime-local'); end.id = 'ev-end';
    const place = input('text', MAX_EVENT_PLACE); place.placeholder = 'Address or call link'; place.id = 'ev-place';
    const note = el('textarea', 'text-input'); note.maxLength = MAX_EVENT_NOTE; note.rows = 3; note.id = 'ev-note';
    const err = el('p', 'error small');
    d.append(
      field('What', title), field('Starts', start), field('Ends (optional)', end), field('Where (optional)', place), field('Details (optional)', note),
      el('p', 'muted small', 'Sent end-to-end encrypted. Everyone in the chat can answer Going, Maybe or Can’t go, and sees each other’s answers.'),
      err,
      actions(button('Cancel', 'ghost', () => d.close()), button('Send event', 'primary', () => {
        const ev = { title: title.value.trim(), start: new Date(start.value).getTime() };
        if (!ev.title) { err.textContent = 'Give the event a name.'; return; }
        if (!Number.isFinite(ev.start)) { err.textContent = 'Pick when it starts.'; return; }
        if (end.value) {
          const e = new Date(end.value).getTime();
          if (!(e > ev.start)) { err.textContent = 'It has to end after it starts.'; return; }
          if (e - ev.start > MAX_EVENT_SPAN) { err.textContent = 'An event can last up to 30 days.'; return; }
          ev.end = e;
        }
        if (place.value.trim()) ev.place = place.value.trim();
        if (note.value.trim()) ev.note = note.value.trim();
        d.close();
        api.sendText(eventFallback(ev), null, { event: ev }, to);
      })),
    );
    d.showModal();
    title.focus();
  }

  function showAnswers(m) {
    const d = dialog(m.event.title);
    const lists = rsvpLists(m);
    for (const k of RSVP) {
      d.append(el('h4', 'ev-list-head', `${RSVP_LABEL[k]} · ${lists[k].length}`));
      const ul = el('ul', 'fwd-list');
      if (!lists[k].length) ul.append(el('li', 'contacts-empty', 'Nobody yet'));
      for (const h of lists[k]) ul.append(el('li', 'contact-name', short(h)));
      d.append(ul);
    }
    d.append(actions(button('Close', 'ghost', () => d.close())));
    d.showModal();
  }

  function renderEvent(li, m) {
    const ev = m.event;
    const s = rsvpSummary(m, me());
    const past = (ev.end || ev.start + 3600_000) < Date.now(); // no end time: counts as an hour, like the calendar file
    const box = el('div', 'ev' + (m.evCancelled ? ' cancelled' : ''));
    box.append(el('div', 'ev-kind', m.evCancelled ? 'Event · cancelled' : past ? 'Event · over' : 'Event'));
    box.append(el('div', 'ev-title', ev.title));
    box.append(el('div', 'ev-when', eventWhen(ev)));
    if (ev.place) box.append(el('div', 'ev-place', ev.place));
    if (ev.note) box.append(el('div', 'ev-note', ev.note));
    if (!m.evCancelled) {
      const row = el('div', 'ev-rsvp');
      for (const k of RSVP) {
        const b = button(RSVP_LABEL[k], 'ev-btn' + (s.mine === k ? ' mine' : ''), (e) => {
          e.stopPropagation();
          if (active()) api.sendAction(active(), 'rsvp', m.id, { going: s.mine === k ? '' : k });
        });
        b.setAttribute('aria-pressed', String(s.mine === k));
        row.append(b);
      }
      box.append(row);
    }
    const foot = el('div', 'ev-foot');
    const counts = button(`${s.yes} going · ${s.maybe} maybe · ${s.no} can’t go`, 'link ev-counts', (e) => { e.stopPropagation(); showAnswers(m); });
    foot.append(counts);
    if (!m.evCancelled) {
      foot.append(button('Add to calendar', 'link ev-ics', (e) => {
        e.stopPropagation();
        download(`${ev.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40) || 'event'}.ics`, eventIcs(ev, m.id), 'text/calendar');
      }));
    }
    box.append(foot);
    li.append(box);
  }

  const cancelItem = menuItem('msg-cancel-event', 'Cancel event', () => {
    const m = api.menuMsg(); api.closeMsgMenu();
    if (m && active() && confirm('Cancel this event for everyone in the chat?')) api.sendAction(active(), 'cancel', m.id);
  });
  const saveStickerItem = menuItem('msg-save-sticker', 'Save sticker', () => {
    const m = api.menuMsg(); api.closeMsgMenu();
    if (m?.media?.data) addSticker({ mime: m.media.mime, data: m.media.data, w: m.media.w, h: m.media.h });
  });
  $('msg-copy')?.before(cancelItem, saveStickerItem);
  function onMsgMenu(m) {
    cancelItem.classList.toggle('hidden', !(m.event && !m.evCancelled && m.from === me() && !m.deleted));
    saveStickerItem.classList.toggle('hidden', !(m.sticker && m.media?.data && !m.deleted && !hasSticker(m.media.data)));
  }

  // ---------- stickers ----------
  const stickers = () => (db().stickers ||= []);
  const hasSticker = (data) => stickers().some((s) => s.data === data);
  function addSticker(s) {
    if (hasSticker(s.data)) { toast('Already in your stickers'); return; }
    if (stickers().length >= MAX_STICKERS) { toast(`You can keep up to ${MAX_STICKERS} stickers. Remove one first.`); return; }
    stickers().unshift({ id: crypto.randomUUID(), mime: s.mime, data: s.data, ...(s.w ? { w: s.w, h: s.h } : {}) });
    api.persist();
    toast('Saved to your stickers');
  }
  const blobB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
  /** A photo becomes a sticker: fitted into a square, transparent around it, WebP (PNG if WebP isn't available). */
  async function makeSticker(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, STICKER_PX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    for (const q of [0.9, 0.75, 0.6, 0.45]) {
      let blob = await new Promise((r) => c.toBlob(r, 'image/webp', q));
      if (!blob || blob.type !== 'image/webp') blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      if (blob && blob.size <= STICKER_BYTES) return { mime: blob.type, data: await blobB64(blob), w, h };
      if (blob?.type === 'image/png') break;
    }
    throw new Error('That picture is too detailed for a sticker. Try a simpler one.');
  }
  const stickerInput = el('input');
  stickerInput.type = 'file'; stickerInput.accept = 'image/png,image/webp,image/jpeg,image/gif'; stickerInput.hidden = true; stickerInput.id = 'sticker-input';
  document.body.append(stickerInput);
  let afterPick = null;
  stickerInput.onchange = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    try { addSticker(await makeSticker(f)); afterPick?.(); } catch (err) { toast(err.message || 'Could not make a sticker from that.'); }
  };

  function sendSticker(s, to) {
    api.sendText('', null, { media: { type: 'image', mime: s.mime, name: 'sticker.' + (s.mime === 'image/png' ? 'png' : 'webp'), data: s.data, ...(s.w ? { w: s.w, h: s.h } : {}) }, sticker: true }, to);
  }

  function openStickers(to = active()) {
    if (!to) return;
    const d = dialog('Stickers', 'sticker-sheet');
    let managing = false;
    const grid = el('div', 'sticker-grid');
    const manage = button('Remove', 'ghost', () => { managing = !managing; draw(); });
    function draw() {
      grid.replaceChildren();
      manage.textContent = managing ? 'Done' : 'Remove';
      manage.classList.toggle('hidden', !stickers().length);
      if (!stickers().length) grid.append(el('p', 'muted small', 'No stickers yet. Make one from a photo, or save one someone sends you (tap and hold it).'));
      for (const s of stickers()) {
        const b = button('', 'sticker-pick' + (managing ? ' managing' : ''), () => {
          if (managing) {
            db().stickers = stickers().filter((x) => x.id !== s.id);
            api.persist(); draw();
          } else { d.close(); sendSticker(s, to); }
        });
        b.setAttribute('aria-label', managing ? 'Remove sticker' : 'Send sticker');
        const img = el('img'); img.alt = ''; img.src = `data:${s.mime};base64,${s.data}`; // mime from our own canvas or a checked message
        b.append(img);
        if (managing) b.append(el('span', 'sticker-x', '×'));
        grid.append(b);
      }
    }
    afterPick = () => { if (d.open) draw(); };
    d.addEventListener('close', () => { afterPick = null; });
    draw();
    d.append(grid, actions(manage, button('Close', 'ghost', () => d.close()), button('New from photo', 'primary', () => stickerInput.click())));
    d.showModal();
  }

  // ---------- favourites ----------
  const favItem = el('button', '', 'Add to Favourites');
  favItem.type = 'button'; favItem.id = 'chat-fav'; favItem.setAttribute('role', 'menuitem');
  favItem.onclick = () => {
    const k = api.menuChat(); api.closeChatMenu();
    if (!k) return;
    const on = !api.prefsOf()[k]?.fav;
    api.setChatPref(k, 'fav', on);
    toast(on ? 'Added to Favourites' : 'Removed from Favourites');
  };
  $('chat-pin')?.after(favItem);
  function onChatMenu(key) {
    favItem.textContent = api.prefsOf()[key]?.fav ? 'Remove from Favourites' : 'Add to Favourites';
  }

  return { openEvent, renderEvent, onMsgMenu, openStickers, onChatMenu, makeSticker, addSticker };
}
