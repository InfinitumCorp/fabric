// End-to-end check of the desktop shell against a local relay (dev build, http://localhost:8795/):
// the app launches, shows the relay's page in the "FabriC++™" window, creates an identity, sends a
// message to a second account (in Microsoft Edge, standing in for another device), places a voice
// call that the other side answers, refuses to navigate to another origin, and saves a screenshot.
//
//   npm run smoke            (relay must be running on :8795; uses fake camera/microphone)
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { _electron: electron, chromium } = require('playwright-core');

const RELAY = 'http://localhost:8795/';
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
