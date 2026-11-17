// Choosing the model in the buddy: presets, switching at runtime, errors, saving, no key leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startBuddyServer } from '../buddy/server.js';
import { createScriptProvider } from '../buddy/providers/script.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

test('the model can be chosen in the buddy and is optionally remembered', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'buddy-model-'));
  const configFile = path.join(dir, 'buddy.config.json');
  writeFileSync(configFile, JSON.stringify({ browser: 'dedicated', mode: 'zelf' }));
  const buddy = await startBuddyServer({
    port: 0, cdpUrl: 'http://127.0.0.1:9', provider: createScriptProvider([]), browser: 'dedicated', mode: 'zelf', bridgeInfo: false, configFile,
  });
  const post = (body) => fetch(`${buddy.url}api/provider`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  const status = async () => (await fetch(`${buddy.url}api/status`)).json();
  try {
    const info = await (await fetch(`${buddy.url}api/providers`)).json();
    assert.deepEqual(info.presets.map((p) => p.id), ['bridge', 'anthropic', 'openai', 'ollama', 'lmstudio', 'openrouter', 'custom']);
    assert.equal(info.active, 'script');

    // Local OpenAI-compatible model (Ollama): no key needed.
    let res = await post({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b', vision: false });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await status()).provider, 'openai · qwen2.5:14b');

    // Invalid choice: readable error, the old model stays.
    res = await post({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: '' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /BUDDY_MODEL|model/i);
    assert.equal((await status()).provider, 'openai · qwen2.5:14b');
    assert.equal((await post({ provider: 'iets' })).status, 400);

    // A typed key is used and saved, but never sent back to the UI.
    res = await post({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-test-geheim', save: true });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await status()).provider, 'anthropic · claude-sonnet-5-5');
    const shown = await (await fetch(`${buddy.url}api/providers`)).text();
    assert.doesNotMatch(shown, /sk-test-geheim/);
    assert.equal(JSON.parse(shown).current.hasKey, true);
    let saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.deepEqual(saved, { browser: 'dedicated', mode: 'zelf', provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-test-geheim' });

    // Switching to the bridge (subscription via your own AI app).
    res = await post({ provider: 'bridge', save: true });
    assert.equal(res.status, 200);
    const st = await status();
    assert.equal(st.provider, 'bridge');
    assert.ok(st.bridge);
    saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.provider, 'bridge');
    assert.equal(saved.apiKey, undefined);
  } finally {
    await buddy.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
