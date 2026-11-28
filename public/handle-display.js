// Handles are written +name.veil everywhere people see them. Underneath (signed device lists, the
// relay, the vault, Supabase) an account is still @name.veil: changing that would invalidate every
// signature, so the + is purely how the app shows and accepts handles.
//
// One pass over the page catches every place a handle lands (lists, threads, calls, toasts, titles,
// tooltips) instead of each of them remembering to convert.

const HANDLE_IN_TEXT = /@([a-z0-9_]{2,24}\.veil)\b/g;
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];

/** '@ana.veil' → '+ana.veil' (and any handle inside a longer string). */
export const showHandles = (s) => (typeof s === 'string' && s.includes('@') ? s.replace(HANDLE_IN_TEXT, '+$1') : s);

function fixText(node) {
  const v = node.nodeValue;
  const w = showHandles(v);
  if (w !== v) node.nodeValue = w;
}

function fixAttrs(elm) {
  for (const a of ATTRS) {
    const v = elm.getAttribute?.(a);
    if (v && v.includes('@')) {
      const w = showHandles(v);
      if (w !== v) elm.setAttribute(a, w);
    }
  }
}

function fixTree(root) {
  if (root.nodeType === Node.TEXT_NODE) return fixText(root);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (root.closest?.('textarea, input, [contenteditable="true"]')) return; // never rewrite what someone is typing
  fixAttrs(root);
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) fixText(n);
    else if (n.matches('textarea, script, style')) continue;
    else fixAttrs(n);
  }
}

export function startHandleDisplay() {
  fixTree(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') fixText(r.target);
      else if (r.type === 'attributes') fixAttrs(r.target);
      else for (const n of r.addedNodes) fixTree(n);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // the tab title
  const t = document.querySelector('title');
  const fixTitle = () => { const w = showHandles(document.title); if (w !== document.title) document.title = w; };
  fixTitle();
  if (t) new MutationObserver(fixTitle).observe(t, { childList: true, characterData: true, subtree: true });
}
