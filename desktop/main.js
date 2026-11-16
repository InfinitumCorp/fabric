// FabriC++ for Windows and macOS: the web client the relay serves, in a native window.
// All crypto, the vault and calls run in the page exactly as in a browser. This shell only adds
// what a desktop app needs (single instance, tray, unread badge, OS notifications, camera and
// microphone for calls, a screen picker) and keeps the window on the relay's own origin.
//
// Relay: release builds are locked to RELEASE_RELAY. The relay serves the app's own code, so
// nothing (arguments, environment, other apps, the page) can repoint a release build.
// Dev builds (`npm run dev`, or `npm run dist:dev`) load DEV_RELAY instead.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  app, BrowserWindow, WebContentsView, Menu, Tray, nativeImage, shell, session,
  desktopCapturer, ipcMain, systemPreferences, globalShortcut,
} = require('electron');
const pkg = require('./package.json');

const RELEASE_RELAY = 'https://relay.infinitumfabric.app/';
const DEV = pkg.fabricDev === true || (!app.isPackaged && process.argv.includes('--dev'));
// Running from source with --dev, FABRIC_DEV_PORT picks another port on localhost (for tests against a
// throwaway relay). Only the port: never another host. Packaged builds, dev or release, ignore it.
const devPort = !app.isPackaged && /^\d{4,5}$/.test(process.env.FABRIC_DEV_PORT || '') ? process.env.FABRIC_DEV_PORT : '8795';
const DEV_RELAY = `http://localhost:${devPort}/`;
const RELAY = new URL(DEV ? DEV_RELAY : RELEASE_RELAY);
const TITLE = 'FabriC++™';
const ACCENT = { r: 0x24, g: 0x54, b: 0xdd };
const asset = (f) => path.join(__dirname, 'assets', f);

// Separate profiles so a dev build never shares a vault or sign-in with the release app.
// FABRIC_DEV_PROFILE (dev builds only) points a run at a throwaway profile, as `npm run smoke` does.
if (DEV) app.setPath('userData', process.env.FABRIC_DEV_PROFILE || path.join(app.getPath('appData'), 'FabriC++ Dev'));
app.setAppUserModelId(DEV ? 'com.infinitum.fabric.dev' : 'com.infinitum.fabric'); // Windows notifications and taskbar grouping

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // a second launch only brings the window up; from its argv nothing is taken but a checked fabric://bot link
  app.on('second-instance', (e, argv) => { showWindow(); openBotLink(argv.find(isBotLink)); });
  app.on('open-url', (e, url) => { e.preventDefault(); showWindow(); openBotLink(url); }); // macOS
  app.whenReady().then(start);
}

let win = null;
let boot = null;
let tray = null;
let quitting = false;
let unread = 0;
let ses = null;

// ---------- the app's own settings (Settings › Desktop app in the page) ----------
const HOTKEY = 'CommandOrControl+Alt+F';
const DEFAULTS = {
  openAtLogin: false, startMinimized: false, closeToTray: true, globalShortcut: true,
  flashFrame: true, spellcheck: true, spellLanguages: [], dndUntil: 0,
};
const settingsFile = () => path.join(app.getPath('userData'), 'desktop-settings.json');
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { settings = { ...DEFAULTS }; }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* read-only profile: keep in memory */ }
}
/** Validates one setting from the page and applies it. Unknown keys and wrong types are refused. */
function setSetting(key, value) {
  if (!Object.hasOwn(DEFAULTS, key) || key === 'dndUntil') throw new Error('unknown setting');
  if (key === 'spellLanguages') {
    const avail = new Set(ses?.availableSpellCheckerLanguages || []);
    if (!Array.isArray(value)) throw new Error('bad value');
    value = [...new Set(value.filter((l) => typeof l === 'string' && (!avail.size || avail.has(l))))].slice(0, 5);
  } else if (typeof value !== 'boolean') throw new Error('bad value');
  settings[key] = value;
  saveSettings();
  applySettings();
  return publicSettings();
}
// Dev builds never register a real login item (it would point at electron.exe); they only keep the choice.
const loginItemsLive = () => app.isPackaged || Boolean(process.env.FABRIC_ALLOW_LOGIN_ITEM);
function publicSettings() {
  const { dndUntil, ...rest } = settings;
  return { ...rest, openAtLogin: loginItemsLive() ? Boolean(app.getLoginItemSettings(loginArgs()).openAtLogin) : settings.openAtLogin };
}
const loginArgs = () => (process.platform === 'win32' ? { args: ['--from-login'] } : {});
function applySettings() {
  if (loginItemsLive()) {
    app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, openAsHidden: settings.startMinimized, ...loginArgs() });
  }
  globalShortcut.unregister(HOTKEY);
  if (settings.globalShortcut) {
    globalShortcut.register(HOTKEY, () => (win?.isVisible() && win.isFocused() ? win.hide() : showWindow()));
  }
  if (ses) {
    ses.setSpellCheckerEnabled(settings.spellcheck);
    if (settings.spellLanguages.length && process.platform !== 'darwin') {
      try { ses.setSpellCheckerLanguages(settings.spellLanguages); } catch { /* language not available */ }
    }
  }
  if (tray) tray.setContextMenu(trayMenu());
}
const startedFromLogin = () => process.argv.includes('--from-login') || app.getLoginItemSettings().wasOpenedAsHidden;

/** Calls from the page: only the relay's page in the main window may use them. */
function fromPage(e) {
  return win && e.sender === win.webContents && sameOrigin(e.senderFrame?.url || '');
}
function setupBridge() {
  ipcMain.handle('desk:get', (e) => (fromPage(e) ? publicSettings() : null));
  ipcMain.handle('desk:set', (e, key, value) => {
    if (!fromPage(e)) throw new Error('not allowed');
    if (key === 'openAtLogin') { settings.openAtLogin = Boolean(value); saveSettings(); applySettings(); return publicSettings(); }
    return setSetting(key, value);
  });
  ipcMain.handle('desk:spell-langs', (e) => (fromPage(e) ? [...(ses?.availableSpellCheckerLanguages || [])].sort() : []));
}
const command = (c) => { if (win && sameOrigin(win.webContents.getURL())) win.webContents.send('desk:command', c); };

const sameOrigin = (u) => {
  try { return new URL(u).origin === RELAY.origin; } catch { return false; }
};

/** Links that leave the relay open in the system browser, never in the app. */
function openOutside(u) {
  try {
    const { protocol } = new URL(u);
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') shell.openExternal(u);
  } catch { /* not a URL: drop it */ }
}

function start() {
  Menu.setApplicationMenu(process.platform === 'darwin' ? macMenu() : null);
  loadSettings();
  ses = session.fromPartition(DEV ? 'persist:fabric-dev' : 'persist:fabric');
  lockSession(ses);
  setupBridge();
  const hidden = settings.startMinimized && startedFromLogin();

  win = new BrowserWindow({
    title: TITLE,
    width: 1180,
    height: 800,
    minWidth: 380,
    minHeight: 520,
    backgroundColor: '#ffffff',
    icon: asset('icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      devTools: DEV,
      preload: path.join(__dirname, 'ui', 'app-preload.js'),
      additionalArguments: [`--fabric-version=${pkg.version}`],
    },
  });
  win.once('ready-to-show', () => { if (!hidden) win.show(); });
  win.on('focus', () => win.flashFrame(false));
  wireContextMenu(win.webContents);

  // The window title stays "FabriC++™"; the page's "(3) FabriC++ · +handle" only feeds the unread badge.
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    const m = /^\((\d+)\)\s/.exec(title);
    setUnread(m ? Number(m[1]) : 0);
  });

  // Closing hides to the tray so messages and calls keep arriving; Quit is in the tray menu.
  win.on('close', (e) => {
    if (quitting || process.platform === 'darwin' && !tray) return;
    if (!settings.closeToTray && process.platform !== 'darwin') { quitting = true; return; }
    e.preventDefault();
    win.hide();
  });

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => { if (isBotLink(url)) openBotLink(url); else openOutside(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!sameOrigin(url)) { e.preventDefault(); if (isBotLink(url)) openBotLink(url); else openOutside(url); } });
  wc.on('will-redirect', (e, url) => { if (!sameOrigin(url)) { e.preventDefault(); openOutside(url); } });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('did-finish-load', () => { if (sameOrigin(wc.getURL())) hideBoot(); });
  wc.on('did-finish-load', () => { if (pendingLink && sameOrigin(wc.getURL())) { const l = pendingLink; pendingLink = null; openBotLink(l); } });
  wc.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 /* ERR_ABORTED */) showBoot('offline');
  });
  wc.on('render-process-gone', () => { showBoot('offline'); });

  showBoot('loading');
  ipcMain.on('boot:retry', (e) => { if (boot && e.sender === boot.webContents) load(); });
  load();

  makeTray();
  applySettings();
  setupScreenPicker(ses);
  app.on('activate', () => showWindow());
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}

/** Right-click in a text field: spelling suggestions, add to dictionary, cut/copy/paste. */
function wireContextMenu(wc) {
  wc.on('context-menu', (_e, p) => {
    if (!p.isEditable && !p.selectionText) return;
    const items = [];
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      if (!p.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false });
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
    }
    if (p.isEditable) items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
    else items.push({ role: 'copy' });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function load() {
  showBoot('loading');
  win.loadURL(RELAY.href).catch(() => { /* did-fail-load shows the retry screen */ });
}

/** The boot screen: the F and wordmark on white, layered over the page until the relay's page loads. */
function showBoot(state) {
  if (!boot) {
    boot = new WebContentsView({
      webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'ui', 'boot-preload.js'), devTools: DEV },
    });
    boot.setBackgroundColor('#ffffff');
    boot.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    boot.webContents.on('will-navigate', (e) => e.preventDefault());
    win.contentView.addChildView(boot);
    const fit = () => { if (boot) { const [w, h] = win.getContentSize(); boot.setBounds({ x: 0, y: 0, width: w, height: h }); } };
    fit();
    win.on('resize', fit);
    boot.webContents.loadFile(path.join(__dirname, 'ui', 'boot.html'))
      .then(() => boot?.webContents.send('boot:state', boot.state))
      .catch(() => {});
  }
  boot.state = state;
  if (!boot.webContents.isLoading()) boot.webContents.send('boot:state', state);
}

function hideBoot() {
  if (!boot) return;
  const b = boot;
  boot = null;
  win.contentView.removeChildView(b);
  b.webContents.close();
}

/** Permissions, certificates and downloads for the app's session. */
function lockSession(ses) {
  const allowed = new Set(['media', 'notifications', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']);
  const fromRelay = (wc, origin) => sameOrigin(origin) && (!wc || sameOrigin(wc.getURL()));

  ses.setPermissionRequestHandler(async (wc, permission, done, details) => {
    const origin = details.requestingUrl || details.securityOrigin || '';
    if (!allowed.has(permission) || !fromRelay(wc, origin)) return done(false);
    if (permission === 'media') return done(await osAllowsMedia(details.mediaTypes || []));
    done(true);
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => allowed.has(permission) && fromRelay(wc, origin));
  ses.setDevicePermissionHandler(() => false); // no USB/HID/serial access
  ses.on('will-download', (e, item) => { item.setSaveDialogOptions({ title: 'Save file' }); }); // files the user saves from a chat
  ses.setUserAgent(`${ses.getUserAgent()} FabricDesktop/${pkg.version}`);
}

/** macOS asks the user once per device; Windows uses its own privacy settings. */
async function osAllowsMedia(types) {
  if (process.platform !== 'darwin') return true;
  for (const t of types) {
    const kind = t === 'video' ? 'camera' : 'microphone';
    if (systemPreferences.getMediaAccessStatus(kind) !== 'granted' && !(await systemPreferences.askForMediaAccess(kind))) return false;
  }
  return true;
}

/**
 * Screen sharing. macOS 15+ shows the OS's own picker. Windows has no OS picker that apps can call,
 * so a small FabriC++ picker lists screens and windows; nothing is shared until the user picks one.
 */
function setupScreenPicker(ses) {
  ses.setDisplayMediaRequestHandler((req, done) => {
    const origin = req.securityOrigin || req.frame?.url || '';
    if (!sameOrigin(origin)) return done({});
    pickSource().then((source) => done(source ? { video: source } : {})).catch(() => done({}));
  }, { useSystemPicker: true });
}

function pickSource() {
  return new Promise((resolve) => {
    let sources = [];
    const picker = new BrowserWindow({
      parent: win,
      modal: true,
      title: 'Share your screen',
      width: 720,
      height: 540,
      resizable: true,
      minimizable: false,
      maximizable: false,
      backgroundColor: '#ffffff',
      icon: asset('icon.png'),
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'ui', 'picker-preload.js'), devTools: DEV },
    });
    picker.setMenu(null);
    picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    picker.webContents.on('will-navigate', (e) => e.preventDefault());
    const finish = (id) => {
      ipcMain.removeHandler('picker:sources');
      ipcMain.removeAllListeners('picker:choose');
      resolve(sources.find((s) => s.id === id) || null);
      if (!picker.isDestroyed()) picker.close();
    };
    ipcMain.handle('picker:sources', async (e) => {
      if (e.sender !== picker.webContents) return [];
      sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } });
      return sources
        .filter((s) => !s.name.startsWith('Share your screen'))
        .map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
    });
    ipcMain.on('picker:choose', (e, id) => { if (e.sender === picker.webContents) finish(id); });
    picker.on('closed', () => finish(null));
    picker.loadFile(path.join(__dirname, 'ui', 'picker.html'));
  });
}

// ---------- bot deep links: fabric://bot/<name>?start=<param> ----------
// Only a bot name and start parameter are taken from a link, and handed to the relay's own page; a link
// can never point the window somewhere else. Release builds register as the handler for fabric://.
const BOT_LINK_RE = /^fabric:\/\/bot\/([a-z0-9_]{1,21}bot)\/?(?:\?start=([A-Za-z0-9_-]{1,64}))?$/i;
const isBotLink = (u) => typeof u === 'string' && BOT_LINK_RE.test(u);
let pendingLink = process.argv.find(isBotLink) || null;
if (!DEV) app.setAsDefaultProtocolClient('fabric');

function openBotLink(u) {
  const m = typeof u === 'string' && BOT_LINK_RE.exec(u);
  if (!m) return;
  const href = `fabric://bot/${m[1].toLowerCase()}${m[2] ? `?start=${m[2]}` : ''}`;
  if (!win || win.webContents.isLoading() || !sameOrigin(win.webContents.getURL())) { pendingLink = href; return; }
  win.webContents.executeJavaScript(`window.fabricOpenLink && window.fabricOpenLink(${JSON.stringify(href)})`).catch(() => {});
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function makeTray() {
  tray = new Tray(trayImage(0));
  tray.setToolTip(TITLE);
  tray.setContextMenu(trayMenu());
  tray.on('click', () => (win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
}

function trayMenu() {
  const dnd = settings.dndUntil > Date.now();
  return Menu.buildFromTemplate([
    { label: 'Open FabriC++', click: showWindow },
    { label: 'Saved messages', click: () => { showWindow(); command('saved'); } },
    { type: 'separator' },
    {
      label: dnd ? 'Turn notifications back on' : 'Mute notifications for 1 hour',
      click: () => {
        settings.dndUntil = dnd ? 0 : Date.now() + 3600e3;
        saveSettings();
        command(dnd ? 'dnd-off' : 'dnd-1h');
        tray.setContextMenu(trayMenu());
      },
    },
    { label: 'Lock now', click: () => command('lock') },
    {
      label: 'Start at login', type: 'checkbox', checked: Boolean(publicSettings().openAtLogin),
      click: (item) => { settings.openAtLogin = item.checked; saveSettings(); applySettings(); },
    },
    { type: 'separator' },
    { label: 'Quit FabriC++', click: () => { quitting = true; app.quit(); } },
  ]);
}

/** The F, with a square accent marker in the corner while there are unread messages. */
function trayImage(count) {
  const base = nativeImage.createFromPath(asset('tray.png')).resize({ width: 32, height: 32 });
  if (!count) return process.platform === 'darwin' ? base.resize({ width: 18, height: 18 }) : base;
  const img = withMarker(base, 14);
  return process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img;
}

/** Paints a square accent block (white hairline edge) into the top-right corner of a bitmap. */
function withMarker(image, size) {
  const { width, height } = image.getSize();
  const px = Buffer.from(image.toBitmap()); // BGRA
  for (let y = 0; y < size; y++) {
    for (let x = width - size; x < width; x++) {
      const i = (y * width + x) * 4;
      const edge = y === size - 1 || x === width - size;
      px[i] = edge ? 0xff : ACCENT.b; px[i + 1] = edge ? 0xff : ACCENT.g; px[i + 2] = edge ? 0xff : ACCENT.r; px[i + 3] = 0xff;
    }
  }
  return nativeImage.createFromBitmap(px, { width, height });
}

function overlayImage() {
  const s = 16;
  const px = Buffer.alloc(s * s * 4);
  for (let i = 0; i < s * s; i++) {
    const x = i % s, y = Math.floor(i / s);
    const edge = x === 0 || y === 0 || x === s - 1 || y === s - 1;
    px[i * 4] = edge ? 0xff : ACCENT.b; px[i * 4 + 1] = edge ? 0xff : ACCENT.g; px[i * 4 + 2] = edge ? 0xff : ACCENT.r; px[i * 4 + 3] = 0xff;
  }
  return nativeImage.createFromBitmap(px, { width: s, height: s });
}

function setUnread(n) {
  if (n === unread) return;
  if (n > unread && settings.flashFrame && !win.isFocused() && settings.dndUntil <= Date.now()) win.flashFrame(true);
  unread = n;
  const label = n ? `${n} unread` : '';
  win.setTitle(n ? `(${n}) ${TITLE}` : TITLE);
  if (tray) { tray.setImage(trayImage(n)); tray.setToolTip(n ? `${TITLE} · ${label}` : TITLE); }
  if (process.platform === 'win32') win.setOverlayIcon(n ? overlayImage() : null, label);
  else app.setBadgeCount(n);
}

function macMenu() {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]);
}
