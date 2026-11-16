// End-to-end check of the desktop shell against a local relay (dev build, http://localhost:8795/):
// the app launches, shows the relay's page in the "FabriC++™" window, creates an identity, sends a
// message to a second account (in Microsoft Edge, standing in for another device), places a voice
// call that the other side answers, refuses to navigate to another origin, and saves a screenshot.
//
//   npm run smoke            (relay must be running on :8795; uses fake camera/microphone)
//   FABRIC_DEV_PORT=8796 npm run smoke   (against a throwaway relay on another port)
//
// It also checks the desktop-class features: the shell's settings bridge, Saved messages,
// formatting, chat folders, drafts, scheduling and the shortcuts sheet.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { _electron: electron, chromium } = require('playwright-core');

const RELAY = `http://localhost:${process.env.FABRIC_DEV_PORT || 8795}/`;
const OUT = path.join(__dirname, '..', 'dist-dev');
const fake = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const tag = Math.random().toString(36).slice(2, 7);
const A = `dtest${tag}a`;
const B = `dtest${tag}b`;
const step = (s) => console.log(`- ${s}`);

async function createIdentity(page, handle) {
  await page.waitForSelector('#onboard-handle', { state: 'visible', timeout: 30000 });
  await page.fill('#onboard-handle', handle);
  await page.click('#onboard-form button[type=submit]');
  await page.waitForSelector('#add-handle', { state: 'visible', timeout: 30000 });
}

async function openChat(page, handle) {
  await page.fill('#add-handle', `+${handle}`);
  await page.press('#add-handle', 'Enter');
  await page.waitForSelector('#text', { state: 'visible', timeout: 15000 });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fabric-smoke-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--dev', ...fake], cwd: path.join(__dirname, '..'), env: { ...process.env, FABRIC_DEV_PROFILE: profile } });
  let peer;
  try {
    // the first web contents may be the boot overlay; wait for the relay's page
    await app.firstWindow();
    let win;
    for (let i = 0; i < 60 && !win; i++) {
      win = app.windows().find((p) => p.url().startsWith(RELAY));
      if (!win) await new Promise((r) => setTimeout(r, 500));
    }
    if (!win) throw new Error('the relay page never loaded');
    step(`window loaded ${win.url()}`);
    const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    if (title !== 'FabriC++™') throw new Error(`window title is "${title}"`);
    step(`window title "${title}"`);

    const edge = await chromium.launch({ channel: 'msedge', headless: true, args: fake });
    peer = await edge.newContext({ permissions: ['camera', 'microphone', 'notifications'] }).then((c) => c.newPage());
    await peer.goto(RELAY);

    await createIdentity(win, A);
    step(`desktop signed in as +${A}`);
    await createIdentity(peer, B);
    step(`peer signed in as +${B}`);

    await openChat(win, B);
    const text = `hello from the desktop app ${tag}`;
    await win.fill('#text', text);
    await win.press('#text', 'Enter');
    await openChat(peer, A);
    await peer.waitForSelector(`#messages :text("${text}")`, { timeout: 30000 });
    step('message delivered to the peer');
    await peer.fill('#text', `hi desktop ${tag}`);
    await peer.press('#text', 'Enter');
    await win.waitForSelector(`#messages :text("hi desktop ${tag}")`, { timeout: 30000 });
    step('reply received on the desktop');

    // ---- desktop-class features ----
    const bridge = await win.evaluate(async () => {
      const d = window.FabricDesktop;
      if (!d) return null;
      const before = await d.getSettings();
      const on = await d.setSetting('openAtLogin', true);
      const off = await d.setSetting('openAtLogin', false);
      let refused = false;
      try { await d.setSetting('relay', 'https://evil.example/'); } catch { refused = true; }
      let badType = false;
      try { await d.setSetting('closeToTray', 'yes'); } catch { badType = true; }
      const langs = await d.spellLanguages();
      return { version: d.version, before, on: on.openAtLogin, off: off.openAtLogin, refused, badType, langs: langs.length };
    });
    if (!bridge) throw new Error('window.FabricDesktop is missing');
    if (!bridge.on || bridge.off || !bridge.refused || !bridge.badType) throw new Error(`settings bridge: ${JSON.stringify(bridge)}`);
    step(`settings bridge v${bridge.version}: start-at-login toggles, unknown and mistyped settings refused, ${bridge.langs} spelling languages`);
    const login = await app.evaluate(({ app }) => app.getLoginItemSettings().openAtLogin);
    if (login) throw new Error('a dev run registered a real login item');

    await win.keyboard.press('Control+0');
    await win.waitForFunction(() => document.getElementById('peer')?.textContent === 'Saved messages');
    await win.fill('#text', '**note** to self https://example.com');
    await win.press('#text', 'Enter');
    await win.waitForSelector('#messages strong.fmt-b');
    await win.waitForSelector('#messages a.msg-link[href^="https://example.com"]');
    step('Saved messages (Ctrl+0) keeps a formatted note with a live link');

    await openChat(win, B);
    await win.fill('#text', 'unsent draft');
    await win.keyboard.press('Control+0');
    await win.waitForFunction(() => [...document.querySelectorAll('#contacts .preview.draft')].some((p) => p.textContent.includes('unsent draft')));
    await openChat(win, B);
    if ((await win.inputValue('#text')) !== 'unsent draft') throw new Error('draft not restored');
    await win.fill('#text', '');
    step('draft kept per chat and shown in the list');

    await win.click('[data-folder=groups]');
    if (await win.locator(`#contacts li[data-key="@${B}.veil"]`).count()) throw new Error('Groups folder shows a 1:1 chat');
    await win.click('[data-folder=all]');
    step('chat folders filter the list');

    await win.fill('#text', `scheduled ${tag}`);
    await win.click('#composer .send-btn', { button: 'right' });
    await win.click('#send-menu >> text=Schedule message…');
    await win.click('dialog[open] button:text-is("In 1 hour")');
    await win.click('dialog[open] button:text-is("Schedule")');
    await win.waitForSelector('#sched-bar:not(.hidden)');
    await win.click('#sched-bar');
    await win.click('dialog[open] button:text-is("Send now")');
    await peer.waitForSelector(`#messages :text("scheduled ${tag}")`, { timeout: 30000 });
    step('scheduled message sent and delivered');

    await win.keyboard.press('Control+/');
    await win.waitForSelector('dialog[open].keys-dialog');
    await win.keyboard.press('Escape');
    await win.click('[data-tab=settings] >> nth=0');
    await win.waitForSelector('#desktop-card [data-setting=closeToTray]');
    await win.click('#back, [data-back] >> nth=0').catch(() => {});
    step('shortcuts sheet and Settings › Desktop app');

    await openChat(win, B);
    await win.click('#call-voice');
    await peer.waitForSelector('#call-accept-voice', { state: 'visible', timeout: 30000 });
    await peer.click('#call-accept-voice');
    await win.waitForFunction(() => /\d+:\d\d/.test(document.getElementById('call-status')?.textContent || ''), null, { timeout: 30000 });
    step(`call connected: ${await win.textContent('#call-status')}`);
    await win.waitForTimeout(1500);
    const shot = path.join(OUT, 'smoke-call.png');
    await win.screenshot({ path: shot });
    step(`screenshot ${shot}`);
    await win.click('#call-end');

    // The shell must keep the window on the relay: another origin opens outside, never in-app.
    await app.evaluate(({ shell }) => { shell.openExternal = async (u) => { global.openedOutside = u; }; });
    await win.evaluate(() => { location.href = 'https://example.com/'; });
    await win.waitForTimeout(1500);
    if (!win.url().startsWith(RELAY)) throw new Error(`navigated to ${win.url()}`);
    const outside = await app.evaluate(() => global.openedOutside);
    if (outside !== 'https://example.com/') throw new Error('external link was not handed to the browser');
    step('other origins open in the system browser, not in the app');

    console.log('smoke test passed');
  } finally {
    await peer?.context().browser().close().catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
})().catch((e) => { console.error(e); process.exit(1); });
