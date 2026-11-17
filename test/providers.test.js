// Unit tests for the buddy: shared tools, provider adapters and the agent loop (no browser, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TOOLS, runTool, toolJsonSchemas } from '../src/tools.js';
import { createOpenAIProvider, toOpenAIToolMessages, parseToolCalls } from '../buddy/providers/openai.js';
import { createAnthropicProvider, buildAnthropicRequest, toAnthropicToolResults } from '../buddy/providers/anthropic.js';
import { createScriptProvider, refByName } from '../buddy/providers/script.js';
import { createProvider, loadConfig } from '../buddy/providers/index.js';
import { BuddyAgent } from '../buddy/agent.js';

const IMG = { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' };
const schemas = toolJsonSchemas();

test('every MCP tool has a JSON schema for providers', () => {
  assert.equal(schemas.length, TOOLS.length);
  assert.deepEqual(schemas.map((s) => s.name), ['tabs', 'open', 'frames', 'snapshot', 'act', 'click_xy', 'press', 'screenshot', 'verify', 'app_events']);
  const act = schemas.find((s) => s.name === 'act');
  assert.equal(act.parameters.type, 'object');
  assert.deepEqual(act.parameters.required, ['ref']);
  assert.equal('$schema' in act.parameters, false);
});

test('runTool rejects unknown tools and bad arguments without touching the browser', async () => {
  const session = { connect: async () => assert.fail('should not connect') };
  const unknown = await runTool(session, 'nope', {});
  assert.equal(unknown.isError, true);
  const bad = await runTool(session, 'act', { ref: 5 });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /ongeldige argumenten voor act/);
});

test('OpenAI: screenshots follow tool messages as a user image message', () => {
  const msgs = toOpenAIToolMessages([{ id: 'c1', content: [IMG, { type: 'text', text: 'Uitsnede' }] }]);
  assert.equal(msgs[0].role, 'tool');
  assert.equal(msgs[0].tool_call_id, 'c1');
  assert.match(msgs[0].content, /Uitsnede/);
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[1].content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
  const noVision = toOpenAIToolMessages([{ id: 'c1', content: [IMG] }], { vision: false });
  assert.equal(noVision.length, 1);
  assert.match(noVision[0].content, /niet doorgegeven/);
});

test('OpenAI: broken JSON arguments become an error call, not a crash', () => {
  const calls = parseToolCalls([
    { id: 'a', function: { name: 'snapshot', arguments: '{}' } },
    { id: 'b', function: { name: 'act', arguments: '{"ref": ' } },
  ]);
  assert.deepEqual(calls[0], { id: 'a', name: 'snapshot', args: {}, error: undefined });
  assert.match(calls[1].error, /geen geldige JSON/);
});

test('OpenAI: full round trip against a mock /chat/completions server', async () => {
  const bodies = [];
  const replies = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] } }] },
    { choices: [{ message: { role: 'assistant', content: 'Ik zie de weerapp.' } }] },
  ];
  const srv = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      bodies.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(d) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replies[bodies.length - 1]));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const p = createOpenAIProvider({ baseUrl: `http://127.0.0.1:${srv.address().port}/v1/`, apiKey: 'k', model: 'm', system: 'S', tools: schemas });
    const agent = new BuddyAgent({ session: {}, provider: p, run: async () => ({ isError: false, content: [IMG, { type: 'text', text: 'Uitsnede @0,0' }] }) });
    assert.equal(await agent.send('Wat zie je?'), 'done');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].url, '/v1/chat/completions');
    assert.equal(bodies[0].auth, 'Bearer k');
    assert.equal(bodies[0].body.tools.length, TOOLS.length);
    assert.equal(bodies[0].body.messages[0].content, 'S');
    const second = bodies[1].body.messages.map((m) => m.role);
    assert.deepEqual(second, ['system', 'user', 'assistant', 'tool', 'user']);
    assert.equal(bodies[1].body.messages[2].tool_calls[0].id, 'c1');
  } finally {
    srv.close();
  }
});

test('Anthropic: request shape and history keep the full response content', async () => {
  const req = buildAnthropicRequest({ model: 'claude-opus-5-5', system: 'S', tools: schemas, messages: [], effort: 'medium' });
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(req.output_config, { effort: 'medium' });
  assert.equal('thinking' in req, false);
  assert.equal('tool_choice' in req, false);
  assert.equal(req.tools[0].input_schema.type, 'object');
  assert.equal(buildAnthropicRequest({ model: 'claude-haiku-4-5', system: 'S', tools: [], messages: [] }).betas, undefined);

  const content = [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: 'Even kijken.' },
    { type: 'tool_use', id: 'tu1', name: 'screenshot', input: {} },
  ];
  const seen = [];
  const client = {
    beta: {
      messages: {
        create: async (r) => {
          seen.push(structuredClone(r));
          return seen.length === 1
            ? { stop_reason: 'tool_use', content }
            : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Klaar.' }] };
        },
      },
    },
  };
  const p = createAnthropicProvider({ client, system: 'S', tools: schemas });
  const events = [];
  const agent = new BuddyAgent({ session: {}, provider: p, emit: (e) => events.push(e), run: async () => ({ isError: false, content: [IMG] }) });
  await agent.send('Kijk');
  assert.deepEqual(seen[1].messages[1], { role: 'assistant', content }); // unchanged, thinking block included
  const result = seen[1].messages[2].content[0];
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, 'tu1');
  assert.equal(result.content[0].type, 'image');
  assert.deepEqual(events.filter((e) => e.type === 'assistant').map((e) => e.text), ['Even kijken.', 'Klaar.']);
});

test('Anthropic: refusal is reported and leaves no assistant turn', async () => {
  const client = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }) } } };
  const p = createAnthropicProvider({ client, system: 'S', tools: schemas });
  p.addUser('x');
  const t = await p.turn();
  assert.match(t.text, /weigerde.*cyber/);
  assert.equal(p.messages.length, 1);
  const errResult = toAnthropicToolResults([{ id: 'x', isError: true, content: [{ type: 'text', text: 'Fout' }] }])[0];
  assert.equal(errResult.is_error, true);
});

test('agent: Stop still answers every tool call and ends with "stopped"', async () => {
  let agent;
  const p = createScriptProvider([{ calls: [{ name: 'frames' }, { name: 'snapshot' }] }, { text: 'nooit' }]);
  const ran = [];
  agent = new BuddyAgent({
    session: {},
    provider: p,
    run: async (_s, name) => {
      ran.push(name);
      agent.stop(); // user presses Stop during the first tool
      return { isError: false, content: [{ type: 'text', text: 'ok' }] };
    },
  });
  assert.equal(await agent.send('ga'), 'stopped');
  assert.deepEqual(ran, ['frames']);
  assert.equal(p.history.length, 2);
  assert.equal(p.history[1].isError, true);
  assert.equal(agent.busy, false);
});

test('agent: step limit and busy guard', async () => {
  const loop = createScriptProvider(Array.from({ length: 10 }, () => ({ calls: [{ name: 'frames' }] })));
  const events = [];
  const agent = new BuddyAgent({ session: {}, provider: loop, maxSteps: 3, emit: (e) => events.push(e), run: async () => ({ isError: false, content: [] }) });
  const running = agent.send('loop');
  await assert.rejects(agent.send('tweede'), /nog bezig/);
  await running;
  assert.equal(events.filter((e) => e.type === 'tool_start').length, 3);
  assert.ok(events.some((e) => e.type === 'error' && /3 stappen/.test(e.text)));
});

test('config: env picks the provider, a missing one gives a readable error', () => {
  assert.match(createProvider(loadConfig({ BUDDY_CONFIG: 'nope.json' })).error, /Geen model ingesteld/);
  assert.match(createProvider(loadConfig({ BUDDY_CONFIG: 'nope.json', BUDDY_PROVIDER: 'openai' })).error, /BUDDY_MODEL/);
  const cfg = loadConfig({ BUDDY_CONFIG: 'nope.json', BUDDY_PROVIDER: 'openai', BUDDY_MODEL: 'qwen', BUDDY_BASE_URL: 'http://localhost:11434/v1', BUDDY_VISION: '0' });
  assert.equal(cfg.vision, false);
  assert.equal(createProvider(cfg).provider.name, 'openai');
  assert.equal(createProvider(loadConfig({ BUDDY_CONFIG: 'nope.json', BUDDY_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'x' })).provider.model, 'claude-opus-5-5');
});

test('refByName finds refs in snapshot text', () => {
  const snap = '  f1:e2 clickable "Amsterdam" @10,10 80x40\n  f1:e3 clickable "Utrecht" @100,10 80x40';
  assert.equal(refByName(snap, 'Utrecht'), 'f1:e3');
  assert.equal(refByName(snap, 'Rotterdam'), null);
});
