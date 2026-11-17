// End-to-end: real Chrome (headless) + demo portal with a cross-origin weather-app iframe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchChrome } from '../scripts/start-chrome.js';
import { startDemo } from '../demo/serve.js';
import { Session } from '../src/browser.js';
import { snapshot, formatSnapshot, formatFrames, listFrames } from '../src/snapshot.js';
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

test('Storyline-like radio overlay reports checked change', async () => {
  const snap = await snapshot(session, { max: 300 });
  const opt = find(snap, 'Bewolkt');
  assert.ok(opt, formatSnapshot(snap));
  assert.equal(opt.role, 'radio');
  assert.equal(opt.overlay, true);
  const res = await act(session, { ref: opt.ref });
  assert.equal(res.changed, true, res.changes.join('\n'));
  assert.ok(res.changes.some((c) => c.includes('[checked]')), res.changes.join('\n'));
  assert.equal((await verify(session, { ref: opt.ref, refHas: 'checked' })).pass, true);
  assert.equal(await appFrame().evaluate(() => window.__demo.radio), 'Bewolkt');
});

test('canvas hit zone is reachable via click_xy', async () => {
  const frame = appFrame();
  await frame.evaluate(() => window.scrollTo(0, 0));
  const snap = await snapshot(session, { max: 400 });
  const canvas = find(snap, 'Weerkaart canvas');
  assert.ok(canvas, formatSnapshot(snap));
  assert.equal(canvas.role, 'canvas');
  const [x, y, w, h] = canvas.rect;
  const res = await clickXY(session, { x: x + Math.round(w * 0.25), y: y + Math.round(h / 2) });
  assert.equal(res.changed, true, res.changes.join('\n'));
  assert.ok(res.changes.some((c) => c.includes('Canvas: zee')), res.changes.join('\n'));
  assert.equal(await frame.evaluate(() => window.__demo.canvasZone), 'zee');
  assert.ok((await frame.evaluate(() => window.__demo.canvasHits)) >= 1);
});

test('hidden snapshot lists display and zero-size controls', async () => {
  const snap = await snapshot(session, { max: 400, hidden: true });
  const items = snap.frames.filter((f) => f.depth === 1).flatMap((f) => f.items || []);
  const display = items.find((i) => i.name === 'Verborgen display');
  const vis = items.find((i) => i.name === 'Verborgen visibility');
  const zero = items.find((i) => i.name === 'Nul-afmeting');
  assert.ok(display, formatSnapshot(snap));
  assert.ok(vis, formatSnapshot(snap));
  assert.ok(zero, formatSnapshot(snap));
  assert.equal(display.hidden, true);
  // display:none collapses the box, so the reported reason is "geen afmeting".
  assert.equal(display.why, 'geen afmeting');
  assert.equal(vis.hidden, true);
  assert.equal(vis.why, 'visibility');
  assert.equal(zero.hidden, true);
  assert.equal(zero.why, 'geen afmeting');
});

test('nested iframe is visible and clickable', async () => {
  const frames = await session.frames();
  assert.ok(frames.some((f) => f.depth === 2 && f.frame.url().includes('nested.html')));
  await appFrame().locator('#nestedFrame').scrollIntoViewIfNeeded();
  const snap = await snapshot(session, { max: 300 });
  const btn = find(snap, 'In nested', 2);
  assert.ok(btn, formatSnapshot(snap));
  const before = await appFrame().evaluate(() => window.__demo.nestedClicks);
  const pauses = await appFrame().evaluate(() => window.__demo.pauses);
  const res = await act(session, { ref: btn.ref });
  assert.equal(res.changed, true, res.changes.join('\n'));
  assert.equal(res.pauses.length, 0, JSON.stringify(res.pauses));
  assert.ok(res.changes.some((c) => c.includes('Nested klik ontvangen')), res.changes.join('\n'));
  const clicks = await appFrame().evaluate(() => window.__demo.nestedClicks);
  assert.equal(clicks, before + 1);
  const after = await appFrame().evaluate(() => ({
    pauses: window.__demo.pauses,
    paused: window.__demo.state.paused,
    clock: document.getElementById('clock').textContent,
  }));
  assert.equal(after.pauses, pauses, after.clock);
  assert.equal(after.paused, false, after.clock);
});

test('closed shadow button is listed and clickable', async () => {
  const snap = await snapshot(session, { max: 400 });
  const btn = find(snap, 'Closed shadow');
  assert.ok(btn, formatSnapshot(snap));
  assert.equal(btn.closedShadow, true);
  const res = await act(session, { ref: btn.ref });
  assert.equal(res.changed, true, res.changes.join('\n'));
  assert.ok(res.changes.some((c) => c.includes('Closed shadow geklikt')), res.changes.join('\n'));
});

test('covered opacity-0 control activates via centre click', async () => {
  await appFrame().locator('#coveredBtn').scrollIntoViewIfNeeded();
  const snap = await snapshot(session, { max: 300 });
  const btn = find(snap, 'Verborgen actie');
  assert.ok(btn, formatSnapshot(snap));
  assert.equal(btn.overlay, true);
  const before = await appFrame().evaluate(() => window.__demo.coveredClicks);
  const res = await act(session, { ref: btn.ref });
  assert.equal(res.changed, true, res.changes.join('\n'));
  assert.ok(res.changes.some((c) => c.includes('Verborgen actie geactiveerd')), res.changes.join('\n'));
  assert.equal(await appFrame().evaluate(() => window.__demo.coveredClicks), before + 1);
});

// Every kind of embedding: the frame is listed with its kind, its button is clickable with
// trusted input, the result inside that frame is reported, and the app does not pause.
const FRAME_KINDS = [
  { name: 'In srcdoc', kind: /srcdoc/, done: 'Geklikt: In srcdoc.' },
  { name: 'In sandbox', kind: /sandbox="allow-scripts".*opaque origin/, done: 'Geklikt: In sandbox.' },
  { name: 'In data', kind: /data:.*opaque origin/, done: 'Geklikt: In data.' },
  { name: 'In about:blank', kind: /about:blank/, done: 'Geklikt: In about:blank.' },
  { name: 'In shadow-iframe', kind: /in shadow DOM/, done: 'Geklikt: In shadow-iframe.' },
  { name: 'Later geladen', kind: /iframe/, done: 'Geklikt: Later geladen.' },
  { name: 'Zonder script', kind: /sandbox="".*opaque origin/, done: 'Inhoud zonder script zichtbaar.' },
];

for (const k of FRAME_KINDS) {
  test(`iframe kind "${k.name}" is listed, labelled and clickable`, async () => {
    let snap, btn;
    for (let i = 0; i < 30; i++) {
      snap = await snapshot(session, { max: 600 });
      btn = find(snap, k.name, 2);
      if (btn) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(btn, formatSnapshot(snap));
    const fid = Number(btn.ref.split(':')[0].slice(1));
    const line = formatFrames(snap.frames.filter((f) => f.id === fid));
    assert.match(line, k.kind);
    assert.doesNotMatch(line, /niet uitleesbaar/);
    const pausesBefore = await appFrame().evaluate(() => window.__demo.pauses);
    const res = await act(session, { ref: btn.ref });
    assert.equal(res.changed, true, res.changes.join('\n'));
    assert.ok(res.changes.some((c) => c.startsWith(`f${fid}:`) && c.includes(k.done)), res.changes.join('\n'));
    assert.equal(res.pauses.length, 0, JSON.stringify(res.pauses));
    assert.equal(await appFrame().evaluate(() => window.__demo.pauses), pausesBefore);
  });
}

test('pause-on-blur switch: focus loss pauses only when enabled', async () => {
  const frame = appFrame();
  await frame.locator('#chal-pause').scrollIntoViewIfNeeded();
  await frame.evaluate(() => {
    const cb = document.getElementById('pauseOnBlur');
    if (!cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
    window.dispatchEvent(new Event('focus'));
  });
  assert.equal(await frame.evaluate(() => window.__demo.state.pauseOnBlur), true);
  assert.equal(await frame.evaluate(() => window.__demo.state.paused), false);

  let snap = await snapshot(session, { max: 400 });
  const toggle = find(snap, 'Pauze bij focusverlies');
  assert.ok(toggle, formatSnapshot(snap));
  assert.equal(toggle.role, 'checkbox');
  assert.ok(toggle.state.includes('checked'), toggle.state);

  // Focus weg van kind-iframes (anders stopt de blur-guard als activeElement een iframe is).
  // Blur = wat de app ziet bij handelen buiten de iframe (zonder focus-emulatie).
  const loseFocus = async () => {
    await frame.evaluate(() => {
      document.getElementById('pauseOnBlur').focus();
      window.dispatchEvent(new Event('blur'));
    });
  };
  const pausesBefore = await frame.evaluate(() => window.__demo.pauses);
  await loseFocus();
  const afterOn = await frame.evaluate(() => ({
    pauses: window.__demo.pauses,
    paused: window.__demo.state.paused,
    reason: window.__demo.lastPauseReason,
    body: document.body.classList.contains('is-paused'),
    banner: document.getElementById('pauseBanner').textContent,
    out: document.getElementById('pauseOut').textContent,
    clock: document.getElementById('clock').textContent,
  }));
  assert.equal(afterOn.pauses, pausesBefore + 1, JSON.stringify(afterOn));
  assert.equal(afterOn.paused, true, JSON.stringify(afterOn));
  assert.equal(afterOn.reason, 'focus kwijt');
  assert.equal(afterOn.body, true);
  assert.match(afterOn.banner, /GEPAUZEERD.*focus kwijt/);
  assert.match(afterOn.out, /Pauze-reactie opgetreden: focus kwijt/);
  assert.match(afterOn.clock, /Gepauzeerd \(focus kwijt\)/);

  // Schakelaar uit → hervat en negeert volgende blur.
  snap = await snapshot(session, { max: 400 });
  const off = await act(session, { ref: find(snap, 'Pauze bij focusverlies').ref });
  assert.equal(off.changed, true, off.changes.join('\n'));
  assert.ok(
    off.changes.some((c) => c.includes('Pauze-reactie uit') || c.includes('[checked]')),
    off.changes.join('\n'),
  );
  assert.equal(await frame.evaluate(() => window.__demo.state.pauseOnBlur), false);
  assert.equal(await frame.evaluate(() => window.__demo.state.paused), false);
  assert.equal(await frame.evaluate(() => document.body.classList.contains('is-paused')), false);

  const pausesMid = await frame.evaluate(() => window.__demo.pauses);
  await loseFocus();
  const afterOff = await frame.evaluate(() => ({
    pauses: window.__demo.pauses,
    paused: window.__demo.state.paused,
    body: document.body.classList.contains('is-paused'),
  }));
  assert.equal(afterOff.pauses, pausesMid);
  assert.equal(afterOff.paused, false);
  assert.equal(afterOff.body, false);

  // Opruimen: schakelaar weer aan, app draait.
  snap = await snapshot(session, { max: 400 });
  await act(session, { ref: find(snap, 'Pauze bij focusverlies').ref });
  await frame.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await frame.evaluate(() => window.__demo.state.pauseOnBlur), true);
  assert.equal(await frame.evaluate(() => window.__demo.state.paused), false);
});

test('srcdoc and about:blank frames are not called cross-origin to their parent app', async () => {
  const frames = await listFrames(session);
  const srcdoc = frames.find((f) => f.url === 'about:srcdoc');
  assert.ok(srcdoc);
  assert.equal(srcdoc.origin, new URL(demo.appUrl).origin);
});
