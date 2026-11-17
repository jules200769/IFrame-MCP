// End-to-end: real Chrome (headless) + demo portal with a cross-origin weather-app iframe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchChrome } from '../scripts/start-chrome.js';
import { startDemo } from '../demo/serve.js';
import { Session } from '../src/browser.js';
import { snapshot, formatSnapshot } from '../src/snapshot.js';
import { act, clickXY, press, screenshot } from '../src/actions.js';
import { verify } from '../src/verify.js';

const PORT = 9333;
let chrome, demo, session, profile;

const find = (snap, name, frameDepth = 1) =>
  snap.frames.filter((f) => f.depth === frameDepth).flatMap((f) => f.items || []).find((i) => i.name === name);

const appFrame = () => session.page.frames().find((f) => f.url().startsWith(demo.appUrl));

before(async () => {
  demo = await startDemo({ hostPort: 5273, appPort: 5274 });
  profile = mkdtempSync(path.join(tmpdir(), 'iframe-agent-'));
  chrome = await launchChrome({ port: PORT, profileDir: profile, headless: true, url: demo.hostUrl });
  session = new Session({ cdpUrl: `http://127.0.0.1:${PORT}` });
  await session.connect();
  await session.page.waitForLoadState('load');
  for (let i = 0; i < 50 && !appFrame(); i++) await new Promise((r) => setTimeout(r, 100));
  await appFrame().waitForLoadState('load');
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

test('snapshot sees inside the cross-origin iframe', async () => {
  const snap = await snapshot(session);
  const text = formatSnapshot(snap);
  const app = snap.frames.find((f) => f.depth === 1);
  assert.ok(app, text);
  assert.equal(app.crossOrigin, true);
  assert.ok(find(snap, 'Utrecht'), text);
  assert.ok(find(snap, 'Volgende dag'), text);
  assert.ok(find(snap, 'Zoek een stad'), text);
  // Coordinates are in page viewport space, i.e. below the portal header.
  assert.ok(find(snap, 'Utrecht').rect[1] > app.box.y, text);
});

test('script clicks do nothing in this app (control check)', async () => {
  const frame = appFrame();
  await frame.evaluate(() => {
    const g = document.querySelector('.tile[data-city="Utrecht"]');
    g.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  const ignored = await frame.evaluate(() => window.__demo.ignored);
  assert.equal(ignored, 1);
  assert.equal(await frame.evaluate(() => window.__demo.state.city), null);
});

test('trusted click selects a city and the outcome is verified', async () => {
  const snap = await snapshot(session);
  const res = await act(session, { ref: find(snap, 'Utrecht').ref, action: 'click' });
  assert.equal(res.changed, true, res.changes.join('\n'));
  assert.ok(res.changes.some((c) => c.includes('Utrecht vandaag: 12°C')), res.changes.join('\n'));
  assert.equal(res.pauses.length, 0);
  const v = await verify(session, { text: 'Utrecht vandaag: 12°C' });
  assert.equal(v.pass, true);
});

test('non-semantic button and failed expectation are reported correctly', async () => {
  const snap = await snapshot(session);
  await act(session, { ref: find(snap, 'Volgende dag').ref });
  assert.equal((await verify(session, { text: 'Utrecht morgen: 14°C' })).pass, true);
  const miss = await verify(session, { text: 'Utrecht vandaag: 12°C' }, 300);
  assert.equal(miss.pass, false);
});

test('typing into an input inside the iframe works', async () => {
  const snap = await snapshot(session);
  const res = await act(session, { ref: find(snap, 'Zoek een stad').ref, action: 'fill', value: 'Groningen' });
  assert.equal(res.changed, true, res.changes.join('\n'));
  assert.equal((await verify(session, { text: 'Groningen vandaag: 8°C' })).pass, true);
});

test('keyboard reaches the focused element in the iframe', async () => {
  await press(session, { key: 'Backspace' });
  const v = await verify(session, { text: 'Groningen vandaag' });
  assert.equal(v.pass, true); // still shown; input changed but no city match
  const snap = await snapshot(session);
  assert.ok(find(snap, 'Zoek een stad').state.includes('value="Groninge"'));
});

test('invisible overlay control is listed by default and its change is detected', async () => {
  const snap = await snapshot(session);
  const box = find(snap, 'Gevoelstemperatuur');
  assert.ok(box, formatSnapshot(snap));
  assert.equal(box.role, 'checkbox');
  assert.equal(box.overlay, true);
  const res = await act(session, { ref: box.ref });
  assert.equal(res.changed, true, res.changes.join('\n'));
  assert.ok(res.changes.some((c) => c.includes('[checked]')), res.changes.join('\n'));
  assert.equal((await verify(session, { ref: box.ref, refHas: 'checked' })).pass, true);
});

test('a change that is only drawn is reported as possibly changed', async () => {
  const b = await appFrame().locator('#fav').boundingBox();
  const res = await clickXY(session, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  assert.equal(res.changed, false, res.changes.join('\n'));
  assert.equal(res.maybe, true, res.changes.join('\n'));
  assert.equal(await appFrame().locator('#favdot').getAttribute('fill'), '#f5a623');
});

test('a stale helper left in the page by an older version is replaced', async () => {
  const frame = appFrame();
  await frame.evaluate(() => {
    window.__iframeAgent.version = 'oud';
  });
  const snap = await snapshot(session);
  assert.ok(find(snap, 'Utrecht'));
  assert.notEqual(await frame.evaluate(() => window.__iframeAgent.version), 'oud');
});

test('the app never paused or lost focus during agent actions', async () => {
  const v = await verify(session, { noPause: true }, 0);
  assert.equal(v.pass, true, JSON.stringify(v.checks));
  assert.equal(await appFrame().evaluate(() => window.__demo.pauses), 0);
});

test('fullscreen iframe: change is reported and the app stays operable', async () => {
  let snap = await snapshot(session);
  const res = await act(session, { ref: find(snap, 'Volledig scherm', 0).ref });
  assert.ok(res.changes.includes('f0: volledig scherm aan'), res.changes.join('\n'));
  snap = await snapshot(session);
  assert.equal(snap.frames.find((f) => f.depth === 1).box.y, 0);
  await act(session, { ref: find(snap, 'Amsterdam').ref });
  assert.equal((await verify(session, { text: 'Amsterdam vandaag: 11°C' })).pass, true);
});

test('a click that opens a new tab is reported', async () => {
  const snap = await snapshot(session);
  const res = await act(session, { ref: find(snap, 'Weerkaart').ref });
  assert.equal(res.changed, true, res.changes.join('\n'));
  assert.equal(res.opened.length, 1);
  assert.ok(res.changes.some((c) => c.includes('nieuwe tab')), res.changes.join('\n'));
  const extra = session.context.pages().find((p) => p !== session.page);
  await extra.close();
  await session.page.bringToFront();
});

test('frame screenshot returns quickly as JPEG', async () => {
  const t = Date.now();
  const { data, clip } = await screenshot(session, { frame: 1 });
  assert.ok(Date.now() - t < 6000);
  assert.ok(Buffer.from(data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
  assert.ok(clip.width > 0 && clip.height > 0);
});
