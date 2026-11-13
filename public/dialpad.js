// On-screen dial pad: 1–9, *, 0, # with letters, plus a delete key. Hold 0 for "+".
// Used to dial a number (writes into an input) and for touch-tones during a phone call.

const KEYS = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

/** A phone or tablet: the pad stands in for the system keyboard there. */
export const isTouch = () => (navigator.maxTouchPoints || 0) > 0 || matchMedia('(pointer: coarse)').matches;

/**
 * @param {HTMLElement} box  where the pad goes (emptied first)
 * @param {{ input?: HTMLInputElement, onKey?: (k: string) => void, back?: boolean }} opts
 *   input: digits are typed into it (and an `input` event fires); onKey: called for every key pressed
 */
export function mountDialpad(box, { input, onKey, back = Boolean(input) } = {}) {
  box.replaceChildren();
  box.classList.add('dialpad');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Dial pad');
  // On a phone the pad replaces the system keyboard; on a computer you can still type.
  if (input && isTouch()) input.setAttribute('inputmode', 'none');

  const put = (k) => {
    onKey?.(k);
    if (!input) return;
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, s) + k + input.value.slice(e);
    input.setSelectionRange?.(s + k.length, s + k.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  for (const [digit, sub] of KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dial-key';
    b.setAttribute('aria-label', digit === '0' ? '0, hold for plus' : digit);
    b.innerHTML = `<span class="dial-digit">${digit}</span><span class="dial-sub">${sub || '&nbsp;'}</span>`;
    if (digit === '0') {
      // hold for "+"
      let timer = null, plus = false;
      b.addEventListener('pointerdown', () => { plus = false; timer = setTimeout(() => { plus = true; put('+'); }, 500); });
      const stop = () => clearTimeout(timer);
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointerleave', stop);
      b.addEventListener('click', () => { if (!plus) put('0'); plus = false; });
    } else {
      b.addEventListener('click', () => put(digit));
    }
    box.append(b);
  }

  if (back) {
    for (let i = 0; i < 2; i++) { const gap = document.createElement('span'); gap.className = 'dial-gap'; box.append(gap); }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'dial-key dial-del';
    del.setAttribute('aria-label', 'Delete');
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h11v14H9l-6-7z"/><path d="M12 9l5 6M17 9l-5 6"/></svg>';
    let hold = null;
    const erase = () => {
      const s = input.selectionStart ?? input.value.length;
      const e = input.selectionEnd ?? input.value.length;
      if (s !== e) input.value = input.value.slice(0, s) + input.value.slice(e);
      else if (s > 0) { input.value = input.value.slice(0, s - 1) + input.value.slice(s); input.setSelectionRange?.(s - 1, s - 1); }
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    del.addEventListener('click', erase);
    // hold to clear
    del.addEventListener('pointerdown', () => { hold = setTimeout(() => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }, 700); });
    del.addEventListener('pointerup', () => clearTimeout(hold));
    del.addEventListener('pointerleave', () => clearTimeout(hold));
    box.append(del);
  }
  return box;
}
