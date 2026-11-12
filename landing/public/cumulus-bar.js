/* Copy of the Cumulus://ID account bar. Canonical file: https://id.cumuluscloud.app/id/bar.js
 * (InfinitumCorp/cumulus-id, public/id/bar.js). Do not edit here: copy the canonical file again. */
/*
 * The Cumulus://ID account bar: the same sign-in, account menu and product launcher in every
 * Infinitum product, the way one Google Account (and Gmail) follows you across Google.
 *
 *   <div data-cumulus-bar></div>
 *   <script src="https://id.cumuluscloud.app/id/bar.js" data-client="scalvs" defer></script>
 *
 * Signed out: "Sign in" and "Create a Cumulus://ID". Signed in: the person's initial; it opens a
 * menu with their name and @cumuluscloud.app address, "Manage your Cumulus://ID", Cumulus://Mail,
 * the product launcher and "Sign out". data-client is the product's client id (src/clients.ts).
 * Optional: data-issuer (a mirror), data-product (highlights the current product in the launcher),
 * data-create="false", data-theme="dark" (on the host element or the script) for dark headers.
 *
 * Sign-in is OAuth 2.0 authorization code + PKCE through page navigations only (no fetch), so it
 * works under a strict CSP; styles live in a shadow root via a constructed stylesheet. The token
 * stays in this tab's sessionStorage, shared with button.js (same key), so a page can use either.
 * Products with their own server session can instead call window.CumulusBar.setProfile(profile)
 * and pass data-signin / data-signout URLs; the bar then only navigates to those.
 *
 * Events on window: "cumulus-id" (detail: profile or null). API: window.CumulusID / CumulusBar.
 */
(() => {
  const script = document.currentScript;
  const ds = (script && script.dataset) || {};
  const ID = (ds.issuer || ds.id || "https://id.cumuluscloud.app").replace(/\/+$/, "");
  const CLIENT = ds.client || "infinitum";
  const PRODUCT = ds.product || CLIENT;
  const KEY = `cumulus-id:${CLIENT}`;
  const PENDING = `${KEY}:pending`;
  const SIGNIN_URL = ds.signin || "";
  const SIGNOUT_URL = ds.signout || "";

  // Every product, as its wordmark. "tm" adds the ™ the brand rules require.
  const APPS = [
    { id: "cumulus-mail", name: "Cumulus://Mail", href: "https://mail.cumuluscloud.app" },
    { id: "cumulus-cloud", name: "Cumulus://Cloud", href: "https://drive.cumuluscloud.app" },
    { id: "cumulus-exchange", name: "Data Exchange", href: "https://exchange.cumuluscloud.app" },
    { id: "scalvs", name: "SCALVS.ai", href: "https://scalvs.app" },
    { id: "architect", name: ":\\ARCHITECT\\", href: "https://rchtch.app" },
    { id: "metatron", name: "METATRON¹⁰⁰", href: "https://mttrn.app" },
    { id: "spectre", name: "+SPCTR", href: "https://spectre.infinitumcorporation.ai" },
    { id: "fabric", name: "FABRIC", href: "https://infinitumfabric.app" },
    { id: "veil", name: "VEIL</>", href: "https://infinitumveil.app" },
    { id: "veil-vpn", name: "VEIL</> VPN", href: "https://infinitumveilvpn.app" },
    { id: "firm-wallet", name: "FIRM Wallet", href: "https://firmwallet.app" },
    { id: "firmament", name: "Firmament Network", href: "https://firmnetwork.app" },
  ];

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch { return null; } },
    set(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  const here = () => { const u = new URL(location.href); u.hash = ""; u.searchParams.delete("code"); u.searchParams.delete("state"); u.searchParams.delete("iss"); return u.toString(); };
  const go = (path, params) => { const u = new URL(path, ID); u.search = new URLSearchParams(params).toString(); location.assign(u.toString()); };

  let external = null; // profile supplied by a product with its own session
  let error = "";

  async function signIn(opts) {
    if (SIGNIN_URL) { const u = new URL(SIGNIN_URL, location.href); if (opts && opts.create) u.searchParams.set("prompt", "create"); location.assign(u.toString()); return; }
    const verifier = random(48);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = random(16);
    const redirect = here();
    store.set(PENDING, { verifier, state, redirect, scroll: scrollY });
    go("/api/id/authorize", { client_id: CLIENT, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, ...(opts && opts.create ? { prompt: "create" } : {}) });
  }

  function signOut() {
    if (SIGNOUT_URL) { location.assign(new URL(SIGNOUT_URL, location.href).toString()); return; }
    const saved = store.get(KEY);
    store.set(KEY, null);
    if (saved && saved.token) go("/api/id/end", { client_id: CLIENT, redirect_uri: here(), token: saved.token });
    else render();
  }

  function finish() {
    const pending = store.get(PENDING);
    const query = new URLSearchParams(location.search);
    const frag = new URLSearchParams(location.hash.slice(1));
    if (frag.has("cid_token") || frag.has("cid_error")) {
      store.set(PENDING, null);
      history.replaceState(null, "", here());
      if (!pending || frag.get("state") !== pending.state) { error = "That sign-in didn't match. Please try again."; return false; }
      if (frag.has("cid_error")) { error = frag.get("cid_error"); return false; }
      try {
        const profile = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(frag.get("profile").replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
        store.set(KEY, { token: frag.get("cid_token"), profile, until: Date.now() + Number(frag.get("expires_in") || 3600) * 1000 });
        if (pending.scroll) requestAnimationFrame(() => scrollTo(0, pending.scroll));
      } catch { error = "Sign-in failed. Please try again."; }
      return false;
    }
    const code = query.get("code"), state = query.get("state");
    if (code && state && pending && !SIGNIN_URL) {
      if (state !== pending.state) { store.set(PENDING, null); history.replaceState(null, "", here()); error = "That sign-in didn't match. Please try again."; return false; }
      go("/api/id/redeem", { client_id: CLIENT, redirect_uri: pending.redirect, code, code_verifier: pending.verifier, state });
      return true;
    }
    return false;
  }

  const current = () => {
    if (external) return { profile: external };
    const s = store.get(KEY);
    if (s && s.until > Date.now()) return s;
    if (s) store.set(KEY, null);
    return null;
  };

  const CSS = `
:host{all:initial;display:inline-block;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.4;color:inherit}
*{box-sizing:border-box}
.wrap{position:relative;display:inline-flex;align-items:center;gap:10px}
button,a{font:inherit;color:inherit}
.btn{display:inline-flex;align-items:center;min-height:36px;padding:0 14px;border:1px solid currentColor;background:transparent;cursor:pointer;border-radius:0;white-space:nowrap;text-decoration:none}
.btn.primary{background:#111820;color:#fff;border-color:#111820}
.btn:hover{background:#2454dd;border-color:#2454dd;color:#fff}
.btn:focus-visible,.avatar:focus-visible,.item:focus-visible,.app:focus-visible{outline:2px solid #2454dd;outline-offset:3px}
.avatar{width:36px;height:36px;border-radius:50%;border:0;background:#111820;color:#fff;font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;text-transform:uppercase}
.avatar:hover{background:#2454dd}
.menu{position:absolute;right:0;top:calc(100% + 10px);z-index:2147483000;width:min(340px,calc(100vw - 24px));background:#fff;color:#111820;border:1px solid #d6dce1;padding:20px;text-align:left}
.menu.left{right:auto;left:0}
.menu[hidden]{display:none}
.who{padding-bottom:16px;border-bottom:1px solid #d6dce1;margin-bottom:12px}
.name{font-size:20px;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.addr{color:#52606b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.org{color:#52606b;font-size:13px;margin-top:2px}
.item{display:block;padding:9px 0;text-decoration:none;border:0;background:none;width:100%;text-align:left;cursor:pointer}
.item:hover,.app:hover{color:#2454dd}
.label{color:#52606b;font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin:14px 0 6px}
.apps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 16px;margin:0;padding:0;list-style:none}
.app{display:block;padding:7px 0;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.app[aria-current="page"]{color:#2454dd}
.foot{border-top:1px solid #d6dce1;margin-top:12px;padding-top:8px}
.tm{font-size:.38em;vertical-align:super;line-height:0;margin-left:.08em}
.err{color:#111820;border-left:2px solid #111820;padding-left:8px;font-size:13px;flex-basis:100%}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:host([data-theme="dark"]) .btn{border-color:#fff;color:#fff}
:host([data-theme="dark"]) .btn.primary{background:#fff;color:#111820;border-color:#fff}
:host([data-theme="dark"]) .btn:hover{background:#2454dd;border-color:#2454dd;color:#fff}
:host([data-theme="dark"]) .avatar{background:#fff;color:#111820}
:host([data-theme="dark"]) .avatar:hover{background:#2454dd;color:#fff}
@media (prefers-reduced-motion:no-preference){.menu{animation:in .18s cubic-bezier(.22,1,.36,1)}@keyframes in{from{opacity:0;transform:translateY(-4px)}}}`;

  let sheet = null;
  try { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); } catch { sheet = null; }

  const h = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
    return n;
  };
  const tm = () => h("sup", { class: "tm", text: "™" });
  const wordmark = (name) => [name, tm()];

  function initial(p) {
    const s = (p && (p.name || p.username || p.email)) || "?";
    return Array.from(s.trim())[0] || "?";
  }

  function menuFor(host, p) {
    const menuId = `cid-menu-${Math.random().toString(36).slice(2)}`;
    const avatar = h("button", { class: "avatar", type: "button", "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": menuId, title: `Cumulus://ID: ${p.name || p.username || ""}\n${p.email || ""}` },
      h("span", { "aria-hidden": "true", text: initial(p) }), h("span", { class: "sr", text: `Account menu for ${p.email || p.username || ""}` }));
    const mailHref = "https://mail.cumuluscloud.app";
    const menu = h("div", { class: "menu", id: menuId, role: "menu", hidden: true },
      h("div", { class: "who" },
        h("div", { class: "name", text: p.name || p.username || "" }),
        h("div", { class: "addr", text: p.email || "" }),
        p.org_name ? h("div", { class: "org", text: p.org_name }) : null),
      h("a", { class: "item", role: "menuitem", href: `${ID}/account`, text: "Manage your Cumulus://ID" }),
      h("a", { class: "item", role: "menuitem", href: mailHref }, ...wordmark("Cumulus://Mail")),
      h("div", { class: "label", text: "Infinitum products" }),
      h("ul", { class: "apps" }, APPS.filter((a) => a.id !== "cumulus-mail").map((a) =>
        h("li", {}, h("a", { class: "app", role: "menuitem", href: a.href, "aria-current": a.id === PRODUCT ? "page" : null }, ...wordmark(a.name))))),
      h("div", { class: "foot" }, h("button", { class: "item", type: "button", role: "menuitem", text: "Sign out", onclick: signOut })));
    const open = (v) => {
      if (v) {
        // Open toward the side with room: a bar on the left of a header opens rightward.
        const r = avatar.getBoundingClientRect();
        menu.classList.toggle("left", r.right < Math.min(340, innerWidth - 24) + 12);
      }
      menu.hidden = !v;
      avatar.setAttribute("aria-expanded", String(v));
      if (v) menu.querySelector("a")?.focus();
    };
    avatar.addEventListener("click", (e) => { e.stopPropagation(); open(menu.hidden); });
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll("a,button")];
      const i = items.indexOf(host.shadowRoot.activeElement);
      if (e.key === "Escape") { open(false); avatar.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    document.addEventListener("click", (e) => { if (!host.contains(e.target)) open(false); });
    return [avatar, menu];
  }

  function render() {
    const s = current();
    const p = s && s.profile;
    for (const host of document.querySelectorAll("[data-cumulus-bar]")) {
      if (ds.theme && !host.dataset.theme) host.dataset.theme = ds.theme;
      const root = host.shadowRoot || host.attachShadow({ mode: "open" });
      if (sheet) root.adoptedStyleSheets = [sheet];
      else if (!root.querySelector("style")) root.append(h("style", { text: CSS }));
      const wrap = h("div", { class: "wrap" });
      if (p) wrap.append(...menuFor(host, p));
      else {
        wrap.append(h("button", { class: "btn primary", type: "button", text: host.dataset.label || "Sign in", onclick: () => signIn() }));
        if ((host.dataset.create || ds.create) !== "false") wrap.append(h("button", { class: "btn", type: "button", text: host.dataset.createLabel || "Create a Cumulus://ID", onclick: () => signIn({ create: true }) }));
        if (error) wrap.append(h("span", { class: "err", role: "alert", text: error }));
      }
      [...root.childNodes].forEach((n) => { if (n.nodeName !== "STYLE") n.remove(); });
      root.append(wrap);
    }
    window.dispatchEvent(new CustomEvent("cumulus-id", { detail: p || null }));
  }

  const api = {
    profile: () => (current() || {}).profile || null,
    token: () => (external ? null : (current() || {}).token || null),
    signIn: () => signIn(),
    create: () => signIn({ create: true }),
    signOut,
    /** For products with their own server session: show this person (or null) without a token here. */
    setProfile(profile) { external = profile || null; render(); },
    apps: APPS.map((a) => ({ ...a })),
  };
  window.CumulusBar = api;
  if (!window.CumulusID) window.CumulusID = api;

  const start = () => { if (!finish()) render(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
