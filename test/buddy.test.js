// End-to-end: buddy server (scripted model) drives the demo in headless Chrome over its chat API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { launchChrome } from '../scripts/start-chrome.js';
import { startDemo } from '../demo/serve.js';
import { startBuddyServer } from '../buddy/server.js';
import { createScriptProvider, refByName } from '../buddy/providers/script.js';

const PORT = 9334;
const JSON_HEADERS = { 'content-type': 'application/json' };
let chrome, demo, buddy, profile, provider;

const steps = [
  { text: 'Ik kijk eerst wat er op het scherm staat.', calls: [{ name: 'snapshot' }] },
  (h) => {
    const ref = refByName(h.at(-1).text, 'Utrecht');
    return ref ? { calls: [{ name: 'act', args: { ref, action: 'click' } }] } : { text: 'Utrecht niet gevonden.' };
  },
  { calls: [{ name: 'verify', args: { text: 'Utrecht vandaag: 12°C', noPause: true } }, { name: 'screenshot', args: { frame: 1 } }] },
  (h) => ({ text: h.at(-2).text.includes('GESLAAGD') ? 'Klaar: Utrecht gekozen, geen pauze.' : `Mislukt: ${h.at(-2).text}` }),
];

// Collects SSE events from the buddy until a "done" event arrives.
async function chat(text, { timeoutMs = 30000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(`${buddy.url}api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  const post = await fetch(`${buddy.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  assert.equal(post.status, 202);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!chunk.startsWith('data: ')) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.type === 'hello') continue;
        events.push(ev);
        if (ev.type === 'done') return events;
      }
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return events;
}

before(async () => {
  demo = await startDemo({ hostPort: 5373, appPort: 5374 });
  profile = mkdtempSync(path.join(tmpdir(), 'iframe-buddy-'));
  chrome = await launchChrome({ port: PORT, profileDir: profile, headless: true, url: demo.hostUrl });
  provider = createScriptProvider(steps);
  buddy = await startBuddyServer({ port: 0, cdpUrl: `http://127.0.0.1:${PORT}`, provider, browser: 'dedicated', mode: 'zelf', bridgeInfo: false });
  const page = buddy.session.page;
  await page.waitForLoadState('load');
  for (let i = 0; i < 50 && !page.frames().some((f) => f.url().startsWith(demo.appUrl)); i++) await new Promise((r) => setTimeout(r, 100));
  buddy.session.markAt = Date.now();
});

after(async () => {
  await buddy?.close();
  chrome?.kill();
  await demo?.close();
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold files briefly on Windows.
  }
});

test('buddy is connected to Chrome at startup and serves its UI', async () => {
  const st = await (await fetch(`${buddy.url}api/status`)).json();
  assert.equal(st.chrome, true, JSON.stringify(st));
  assert.equal(st.provider, 'script');
  assert.equal(st.busy, false);
  assert.match(st.tab.title, /Demo-portaal/);
  const html = await (await fetch(buddy.url)).text();
  assert.match(html, /<title>iframe-buddy<\/title>/);
  assert.equal((await fetch(`${buddy.url}..%2F..%2Fpackage.json`)).status, 404);
});

test('chat message drives the cross-origin iframe and verifies the outcome', async () => {
  const events = await chat('Kies Utrecht en controleer dat de app niet pauzeerde.');
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'user');
  assert.equal(events.at(-1).outcome, 'done', JSON.stringify(events.filter((e) => e.type === 'error')));
  const ends = events.filter((e) => e.type === 'tool_end');
  assert.deepEqual(ends.map((e) => e.name), ['snapshot', 'act', 'verify', 'screenshot']);
  assert.ok(ends.every((e) => !e.isError), ends.map((e) => e.summary).join('\n'));
  assert.match(ends[1].summary, /VERANDERD/);
  assert.match(ends[2].summary, /GESLAAGD/);
  assert.equal(ends[3].image.mimeType, 'image/jpeg');
  assert.equal(events.filter((e) => e.type === 'assistant').at(-1).text, 'Klaar: Utrecht gekozen, geen pauze.');

  const app = buddy.session.page.frames().find((f) => f.url().startsWith(demo.appUrl));
  assert.equal(await app.evaluate(() => window.__demo.state.city), 'Utrecht');
  const st = await (await fetch(`${buddy.url}api/status`)).json();
  assert.equal(st.pauses, 0);
});

test('a reconnecting UI gets the conversation replayed; reset clears it', async () => {
  const res = await fetch(`${buddy.url}api/events`);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const hello = JSON.parse(new TextDecoder().decode(value).split('\n')[0].slice(6));
  assert.equal(hello.type, 'hello');
  assert.ok(hello.history.some((e) => e.type === 'tool_end' && e.name === 'act'));

  assert.equal((await fetch(`${buddy.url}api/reset`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status, 200);
  const res2 = await fetch(`${buddy.url}api/events`);
  const r2 = res2.body.getReader();
  const { value: v2 } = await r2.read();
  await r2.cancel();
  assert.deepEqual(JSON.parse(new TextDecoder().decode(v2).split('\n')[0].slice(6)).history, []);
});

test('chat without text is rejected', async () => {
  const res = await fetch(`${buddy.url}api/chat`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
  assert.equal(res.status, 400);
});

test('a web page cannot drive the buddy (cross-site POST, plain-text CSRF, foreign Host)', async () => {
  const body = JSON.stringify({ text: 'klik op betalen' });
  const usersBefore = provider.users.length;
  const evil = await fetch(`${buddy.url}api/chat`, { method: 'POST', headers: { ...JSON_HEADERS, origin: 'https://evil.example' }, body });
  assert.equal(evil.status, 403);
  // A form or no-cors fetch can only send "simple" content types.
  const plain = await fetch(`${buddy.url}api/chat`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
  assert.equal(plain.status, 415);
  const rebinding = await new Promise((resolve) => {
    const req = http.request(`${buddy.url}api/status`, { headers: { host: 'evil.example:5199' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.end();
  });
  assert.equal(rebinding, 403);
  // Bridge endpoints need the token (and this buddy is no bridge at all).
  assert.equal((await fetch(`${buddy.url}api/bridge/next?timeoutMs=0`)).status, 401);
  assert.equal(provider.users.length, usersBefore); // nothing reached the model
});
