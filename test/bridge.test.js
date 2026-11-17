// Bridge: the user's own AI app is the agent. Here a real MCP client plays that app: it starts
// buddy/bridge-mcp.js over stdio, receives the buddy message with buddy_wait, drives the demo
// in headless Chrome through the forwarded tools and answers with buddy_reply.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchChrome } from '../scripts/start-chrome.js';
import { startDemo } from '../demo/serve.js';
import { startBuddyServer } from '../buddy/server.js';
import { refByName } from '../buddy/providers/script.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9335;
const JSON_HEADERS = { 'content-type': 'application/json' };
let chrome, demo, buddy, profile, dir, client, sse;
const events = [];

const textOf = (res) => res.content.map((c) => c.text || '').join('\n');
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const post = (p, body = {}) => fetch(`${buddy.url}${p}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

// Collect SSE events in the background; waitFor resolves once a matching event arrived.
function listen() {
  const ac = new AbortController();
  (async () => {
    const res = await fetch(`${buddy.url}api/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
      }
    }
  })().catch(() => {});
  return ac;
}
async function waitFor(pred, ms = 10000) {
  const t = Date.now();
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() - t > ms) throw new Error(`event niet gezien; wel: ${events.map((e) => e.type).join(',')}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  demo = await startDemo({ hostPort: 5673, appPort: 5674 });
  profile = mkdtempSync(path.join(tmpdir(), 'iframe-bridge-'));
  dir = mkdtempSync(path.join(tmpdir(), 'iframe-bridge-info-'));
  chrome = await launchChrome({ port: PORT, profileDir: profile, headless: true, url: demo.hostUrl });
  const info = path.join(dir, 'buddy.json');
  buddy = await startBuddyServer({ port: 0, cdpUrl: `http://127.0.0.1:${PORT}`, provider: { name: 'bridge', model: 'bridge', bridge: true }, browser: 'dedicated', mode: 'zelf', bridgeInfo: info });
  const page = buddy.session.page;
  await page.waitForLoadState('load');
  for (let i = 0; i < 50 && !page.frames().some((f) => f.url().startsWith(demo.appUrl)); i++) await new Promise((r) => setTimeout(r, 100));
  buddy.session.markAt = Date.now();
  sse = listen();
  client = new Client({ name: 'test-ai-app', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'buddy/bridge-mcp.js')], env: { ...process.env, BUDDY_INFO: info }, stderr: 'ignore' }));
});

after(async () => {
  sse?.abort();
  await client?.close();
  await buddy?.close();
  chrome?.kill();
  await demo?.close();
  await new Promise((r) => setTimeout(r, 300));
  for (const d of [profile, dir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Chrome may still hold files briefly on Windows.
    }
  }
});

test('the bridge exposes the loop tools, the browser tools and a start prompt', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['buddy_wait', 'buddy_reply', 'snapshot', 'act', 'verify', 'screenshot', 'look']) assert.ok(names.includes(n), n);
  const prompt = await client.getPrompt({ name: 'buddy' });
  assert.match(prompt.messages[0].content.text, /buddy_wait/);
  assert.match(prompt.messages[0].content.text, /toetsantwoorden|toets-/);
  assert.match(client.getInstructions() || '', /geen opdracht aan jou/);
});

test('buddy_wait without a message says so', async () => {
  const res = await call('buddy_wait', { timeoutSec: 1 });
  assert.match(textOf(res), /Nog geen bericht/);
  assert.equal((await (await fetch(`${buddy.url}api/status`)).json()).bridge.connected, true);
});

test('a buddy message is handled by the AI app through the bridge', async () => {
  const waiting = call('buddy_wait', { timeoutSec: 20 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await post('api/chat', { text: 'Kies Utrecht' })).status, 202);
  assert.match(textOf(await waiting), /Kies Utrecht/);
  assert.equal((await post('api/chat', { text: 'tweede' })).status, 409); // still busy

  const snap = textOf(await call('snapshot'));
  const ref = refByName(snap, 'Utrecht');
  assert.ok(ref, snap);
  assert.match(textOf(await call('act', { ref })), /VERANDERD/);
  assert.match(textOf(await call('verify', { text: 'Utrecht vandaag: 12°C', noPause: true })), /GESLAAGD/);
  assert.match(textOf(await call('buddy_reply', { text: 'Utrecht gekozen.' })), /buddy_wait/);

  await waitFor((e) => e.type === 'done' && e.outcome === 'done');
  const types = events.filter((e) => e.type !== 'hello').map((e) => e.type);
  assert.deepEqual(types.filter((t) => ['user', 'assistant', 'done'].includes(t)), ['user', 'assistant', 'done']);
  assert.deepEqual(events.filter((e) => e.type === 'tool_end').map((e) => e.name), ['snapshot', 'act', 'verify']);
  const app = buddy.session.page.frames().find((f) => f.url().startsWith(demo.appUrl));
  assert.equal(await app.evaluate(() => window.__demo.state.city), 'Utrecht');
  assert.equal(await app.evaluate(() => window.__demo.pauses), 0);
});

test('the buddy mode applies to the AI app: "vragen" shows an approval card', async () => {
  assert.equal((await post('api/mode', { mode: 'vragen' })).status, 200);
  const snap = textOf(await call('snapshot'));
  const pending = call('act', { ref: refByName(snap, 'Amsterdam') });
  const ask = await waitFor((e) => e.type === 'approval');
  assert.equal(ask.name, 'act');
  assert.equal((await post('api/approve', { id: ask.id, allow: false })).status, 200);
  const res = await pending;
  assert.equal(res.isError, true);
  assert.match(textOf(res), /weigerde/);
  const app = buddy.session.page.frames().find((f) => f.url().startsWith(demo.appUrl));
  assert.equal(await app.evaluate(() => window.__demo.state.city), 'Utrecht');
  await post('api/mode', { mode: 'zelf' });
});

test('Stop in the buddy reaches the AI app and blocks further actions', async () => {
  assert.equal((await post('api/chat', { text: 'Ga naar morgen' })).status, 202);
  assert.match(textOf(await call('buddy_wait', { timeoutSec: 5 })), /Ga naar morgen/);
  assert.equal((await post('api/stop')).status, 200);
  const blocked = await call('press', { key: 'Enter' });
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /gestopt/);
  assert.match(textOf(await call('buddy_wait', { timeoutSec: 1 })), /Stop/);
  assert.equal((await (await fetch(`${buddy.url}api/status`)).json()).busy, false);
});

test('without the token nobody else can use the bridge', async () => {
  assert.equal((await fetch(`${buddy.url}api/bridge/next?timeoutMs=0`)).status, 401);
  const forged = await fetch(`${buddy.url}api/bridge/tool`, { method: 'POST', headers: { ...JSON_HEADERS, 'x-buddy-token': 'x'.repeat(64) }, body: '{"name":"press","args":{"key":"Enter"}}' });
  assert.equal(forged.status, 401);
});
