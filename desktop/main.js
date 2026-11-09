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
const {
  app, BrowserWindow, WebContentsView, Menu, Tray, nativeImage, shell, session,
  desktopCapturer, ipcMain, systemPreferences,
} = require('electron');
const pkg = require('./package.json');

const RELEASE_RELAY = 'https://relay.infinitumfabric.app/';
const DEV_RELAY = 'http://localhost:8795/';
const DEV = pkg.fabricDev === true || (!app.isPackaged && process.argv.includes('--dev'));
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
  const ses = session.fromPartition(DEV ? 'persist:fabric-dev' : 'persist:fabric');
  lockSession(ses);

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
    },
  });
  win.once('ready-to-show', () => win.show());

  // The window title stays "FabriC++™"; the page's "(3) FabriC++ · +handle" only feeds the unread badge.
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    const m = /^\((\d+)\)\s/.exec(title);
    setUnread(m ? Number(m[1]) : 0);
  });

  // Closing hides to the tray so messages and calls keep arriving; Quit is in the tray menu.
  win.on('close', (e) => {
    if (quitting || process.platform === 'darwin' && !tray) return;
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
  setupScreenPicker(ses);
  app.on('activate', () => showWindow());
  app.on('before-quit', () => { quitting = true; });
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open FabriC++', click: showWindow },
    { type: 'separator' },
    { label: 'Quit FabriC++', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => (win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
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
