// "user" mode: connect to an everyday Chrome through its DevToolsActivePort file, touch only
// the working tab, and never reconnect (= a new permission dialog) without being asked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findChrome } from '../scripts/start-chrome.js';
import { startDemo } from '../demo/serve.js';
import { Session } from '../src/browser.js';
import { parseDevToolsActivePort, readDevToolsActivePort, chromeUserDataDir } from '../src/endpoint.js';
import { runTool } from '../src/tools.js';

let chrome, demo, profile, session;
const text = (res) => res.content.map((c) => c.text).join('\n');

before(async () => {
  demo = await startDemo({ hostPort: 5573, appPort: 5574 });
  profile = mkdtempSync(path.join(tmpdir(), 'iframe-user-'));
  // Like an everyday Chrome: no keep-alive flags. Port 0 makes Chrome pick a port and write
  // DevToolsActivePort into the profile, as the chrome://inspect switch does.
  chrome = spawn(findChrome(), [
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--headless=new', '--window-size=1280,900', demo.hostUrl,
  ], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(path.join(profile, 'DevToolsActivePort')); i++) await new Promise((r) => setTimeout(r, 100));
  session = new Session({ browser: 'user', userDataDir: profile });
});

after(async () => {
  await session?.close();
  chrome?.kill();
  await demo?.close();
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold files briefly on Windows.
  }
});

test('DevToolsActivePort is parsed into a browser WebSocket endpoint', () => {
  const ep = parseDevToolsActivePort('52011\n/devtools/browser/0f1e2d3c\n');
  assert.deepEqual(ep, { port: 52011, path: '/devtools/browser/0f1e2d3c', wsEndpoint: 'ws://127.0.0.1:52011/devtools/browser/0f1e2d3c' });
  assert.throws(() => parseDevToolsActivePort('abc\n/devtools/browser/x'), /poort/);
  assert.throws(() => parseDevToolsActivePort('9222\n'), /browserpad/);
});

test('a missing DevToolsActivePort explains how to enable remote debugging', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'iframe-nochrome-'));
  assert.throws(() => readDevToolsActivePort(empty), /chrome:\/\/inspect\/#remote-debugging/);
  rmSync(empty, { recursive: true, force: true });
  assert.equal(chromeUserDataDir({ CHROME_USER_DATA_DIR: 'X:/p' }), 'X:/p');
  assert.match(chromeUserDataDir({ LOCALAPPDATA: 'C:/L' }, 'win32'), /Google[\\/]Chrome[\\/]User Data$/);
});

test('user mode connects to the visible tab and sees into its cross-origin iframe', async () => {
  await session.connect();
  assert.equal(session.kind, 'user');
  assert.match(session.page.url(), /localhost:5573/);
  let snap = '';
  for (let i = 0; i < 30 && !snap.includes('"Utrecht"'); i++) {
    snap = text(await runTool(session, 'snapshot', {}));
    if (!snap.includes('"Utrecht"')) await new Promise((r) => setTimeout(r, 150));
  }
  assert.match(snap, /clickable "Utrecht"/);
});

test('other tabs are left alone until the agent selects them', async () => {
  const other = await session.context.newPage();
  await other.goto(demo.appUrl);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await other.evaluate(() => typeof window.__iframeAgent), 'undefined');
  const index = session.context.pages().indexOf(other);
  const res = await runTool(session, 'tabs', { select: index });
  assert.equal(res.isError, false, text(res));
  assert.equal(session.page, other);
  assert.match(text(await runTool(session, 'snapshot', {})), /"Utrecht"/);
  assert.equal(await other.evaluate(() => typeof window.__iframeAgent), 'object');
});

test('after a lost connection no new permission dialog is opened without asking', async () => {
  await session.browser.close();
  const res = await runTool(session, 'frames', {});
  assert.equal(res.isError, true);
  assert.match(text(res), /Koppel/);
  await session.connect({ explicit: true });
  assert.equal(session.connected, true);
  assert.equal((await runTool(session, 'frames', {})).isError, false);
});
