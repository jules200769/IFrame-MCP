// Modes (kijken / vragen / zelf), approvals and the "look" tool, without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallRunner, isMutating, REFUSED_LOOK_ONLY, REFUSED_BY_USER, STOPPED } from '../buddy/policy.js';
import { BUDDY_TOOLS, LOOK_UNAVAILABLE } from '../buddy/tools.js';
import { runTool, toolJsonSchemas } from '../src/tools.js';
import { startBuddyServer } from '../buddy/server.js';
import { createScriptProvider } from '../buddy/providers/script.js';

const ok = { isError: false, content: [{ type: 'text', text: 'ok' }] };
const JSON_HEADERS = { 'content-type': 'application/json' };
const textOf = (res) => res.content.map((c) => c.text || '').join('\n');

function runnerWith(mode) {
  const events = [];
  const ran = [];
  const runner = new CallRunner({ session: {}, mode, emit: (e) => events.push(e), run: async (_s, name) => (ran.push(name), ok) });
  return { runner, events, ran };
}

test('which calls count as actions', () => {
  for (const n of ['act', 'click_xy', 'press', 'open', 'iets_nieuws']) assert.equal(isMutating(n, {}), true, n);
  for (const n of ['snapshot', 'frames', 'screenshot', 'verify', 'app_events', 'look']) assert.equal(isMutating(n, {}), false, n);
  assert.equal(isMutating('tabs', {}), false);
  assert.equal(isMutating('tabs', { select: 1 }), false);
  assert.equal(isMutating('tabs', { close: 2 }), true);
  assert.equal(isMutating('tabs', { front: true }), true);
});

test('"kijken" refuses actions but still reads', async () => {
  const { runner, ran } = runnerWith('kijken');
  const res = await runner.runCall({ id: 'c1', name: 'act', args: { ref: 'f1:e1' } });
  assert.equal(res.isError, true);
  assert.equal(textOf(res), REFUSED_LOOK_ONLY);
  assert.equal((await runner.runCall({ id: 'c2', name: 'snapshot', args: {} })).isError, false);
  assert.deepEqual(ran, ['snapshot']);
});

test('"vragen" waits for the user: allow runs the action, deny refuses it', async () => {
  const { runner, events, ran } = runnerWith('vragen');
  const p1 = runner.runCall({ id: 'c1', name: 'act', args: { ref: 'f1:e1' } });
  await new Promise((r) => setImmediate(r));
  const ask = events.find((e) => e.type === 'approval');
  assert.ok(ask);
  assert.equal(ask.name, 'act');
  assert.deepEqual(runner.waiting.map((w) => w.id), [ask.id]);
  assert.deepEqual(ran, []);
  assert.equal(runner.answer(ask.id, true), true);
  assert.equal((await p1).isError, false);
  assert.deepEqual(ran, ['act']);

  const p2 = runner.runCall({ id: 'c2', name: 'press', args: { key: 'Enter' } });
  await new Promise((r) => setImmediate(r));
  const ask2 = events.filter((e) => e.type === 'approval').at(-1);
  runner.answer(ask2.id, false);
  assert.equal(textOf(await p2), REFUSED_BY_USER);
  assert.deepEqual(ran, ['act']);
  assert.equal(runner.answer(ask2.id, true), false); // already answered
  assert.deepEqual(events.filter((e) => e.type === 'approval_done').map((e) => e.allow), [true, false]);
});

test('Stop during an open question refuses it; switching to "zelf" allows what waits', async () => {
  const { runner, ran } = runnerWith('vragen');
  const ac = new AbortController();
  const p = runner.runCall({ id: 'c1', name: 'act', args: {} }, { signal: ac.signal });
  ac.abort();
  assert.equal(textOf(await p), STOPPED);
  const q = runner.runCall({ id: 'c2', name: 'click_xy', args: { x: 1, y: 1 } });
  await new Promise((r) => setImmediate(r));
  runner.setMode('zelf');
  assert.equal((await q).isError, false);
  assert.deepEqual(ran, ['click_xy']);
  assert.throws(() => runner.setMode('alles'), /Onbekende modus/);
});

test('look returns the window capture and needs no browser connection', async () => {
  const session = { connect: async () => assert.fail('look must not connect to Chrome') };
  const capture = async ({ match }) => ({ data: '/9j/AA==', title: `Demo - Google Chrome${match ? ` (${match})` : ''}`, width: 800, height: 600 });
  const res = await runTool(session, 'look', {}, { extraTools: BUDDY_TOOLS, ctx: { capture } });
  assert.equal(res.isError, false, textOf(res));
  assert.equal(res.content[0].type, 'image');
  assert.match(textOf(res), /Demo - Google Chrome/);
  const none = await runTool(session, 'look', {}, { extraTools: BUDDY_TOOLS, ctx: {} });
  assert.equal(none.isError, true);
  assert.match(textOf(none), new RegExp(LOOK_UNAVAILABLE.slice(0, 30)));
  assert.ok(toolJsonSchemas(BUDDY_TOOLS).some((t) => t.name === 'look'));
  assert.equal(toolJsonSchemas().some((t) => t.name === 'look'), false);
});

// Server level: SSE approval card → POST /api/approve, plus /api/mode. No Chrome is running,
// which is fine: the refused action never reaches the browser, and "look" needs none.
test('buddy server: approval round-trip over HTTP and look without Chrome', async () => {
  const provider = createScriptProvider([
    { calls: [{ name: 'press', args: { key: 'Enter' } }] },
    (h) => ({ text: `press: ${h.at(-1).text}`, calls: [{ name: 'look' }] }),
    (h) => ({ text: `look: ${h.at(-1).images} beeld` }),
  ]);
  const capture = async () => ({ data: '/9j/AA==', title: 'App - Google Chrome', width: 10, height: 10 });
  const buddy = await startBuddyServer({ port: 0, cdpUrl: 'http://127.0.0.1:9', provider, browser: 'dedicated', mode: 'vragen', capture, bridgeInfo: false });
  const ac = new AbortController();
  try {
    const st = await (await fetch(`${buddy.url}api/status`)).json();
    assert.equal(st.mode, 'vragen');
    assert.equal(st.chrome, false);
    assert.equal(st.capture, true);

    const events = [];
    const sse = await fetch(`${buddy.url}api/events`, { signal: ac.signal });
    const reader = sse.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const next = async (type) => {
      for (;;) {
        const hit = events.find((e) => e.type === type && !e.seen);
        if (hit) {
          hit.seen = true;
          return hit;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE ended');
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
        }
      }
    };
    await next('hello');
    const post = (p, body) => fetch(`${buddy.url}${p}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
    assert.equal((await post('api/chat', { text: 'druk op Enter' })).status, 202);
    const ask = await next('approval');
    assert.equal(ask.name, 'press');
    assert.equal((await post('api/approve', { id: ask.id, allow: false })).status, 200);
    assert.equal((await post('api/approve', { id: ask.id, allow: true })).status, 404);
    const done = await next('done');
    assert.equal(done.outcome, 'done');
    const said = events.filter((e) => e.type === 'assistant').map((e) => e.text);
    assert.match(said[0], /weigerde/);
    assert.equal(said[1], 'look: 1 beeld');

    assert.equal((await post('api/mode', { mode: 'kijken' })).status, 200);
    assert.equal((await (await fetch(`${buddy.url}api/status`)).json()).mode, 'kijken');
    assert.equal((await post('api/mode', { mode: 'alles' })).status, 400);
  } finally {
    ac.abort();
    await buddy.close();
  }
});
