// Picks the model provider from env vars, optionally overridden by buddy.config.json in the project root.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolJsonSchemas } from '../../src/tools.js';
import { SYSTEM_PROMPT } from '../prompt.js';
import { BUDDY_TOOLS } from '../tools.js';
import { createOpenAIProvider } from './openai.js';
import { createAnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { createScriptProvider } from './script.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const configPath = (env = process.env) => env.BUDDY_CONFIG || path.join(ROOT, 'buddy.config.json');

// Choices offered in the buddy's model menu. model/baseUrl are only pre-filled suggestions.
export const PRESETS = [
  { id: 'bridge', label: 'Je eigen AI-app (abonnement, via bridge)', provider: 'bridge' },
  { id: 'anthropic', label: 'Anthropic (Claude, API-key)', provider: 'anthropic', model: DEFAULT_ANTHROPIC_MODEL, needsKey: true },
  { id: 'openai', label: 'OpenAI (API-key)', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', needsKey: true },
  { id: 'ollama', label: 'Ollama (lokaal, gratis)', provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
  { id: 'lmstudio', label: 'LM Studio (lokaal)', provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: '' },
  { id: 'openrouter', label: 'OpenRouter (API-key)', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '', needsKey: true },
  { id: 'custom', label: 'Andere OpenAI-compatibele server', provider: 'openai', baseUrl: '', model: '' },
];

export function loadConfig(env = process.env) {
  let file = {};
  const p = configPath(env);
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`buddy.config.json is geen geldige JSON: ${e.message}`);
    }
  }
  const pick = (k, envKey) => file[k] ?? env[envKey];
  const provider = (pick('provider', 'BUDDY_PROVIDER') || '').toLowerCase();
  return {
    provider,
    model: pick('model', 'BUDDY_MODEL'),
    baseUrl: pick('baseUrl', 'BUDDY_BASE_URL'),
    apiKey:
      pick('apiKey', 'BUDDY_API_KEY') ||
      (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : provider === 'openai' ? env.OPENAI_API_KEY : undefined),
    vision: String(pick('vision', 'BUDDY_VISION') ?? '1') !== '0' && pick('vision', 'BUDDY_VISION') !== false,
    effort: pick('effort', 'BUDDY_EFFORT') || 'medium',
    // Which Chrome: "dedicated" (npm run chrome) or "user" (your everyday Chrome, Chrome 144+).
    browser: (pick('browser', 'BUDDY_BROWSER') || 'dedicated').toLowerCase(),
    // kijken | vragen | zelf; default depends on the browser (see buddy/server.js).
    mode: pick('mode', 'BUDDY_MODE'),
  };
}

// Returns { provider } or { error } with a readable reason (shown in the UI).
export function createProvider(cfg = loadConfig()) {
  const common = { system: SYSTEM_PROMPT, tools: toolJsonSchemas(BUDDY_TOOLS), vision: cfg.vision };
  try {
    switch (cfg.provider) {
      case 'openai':
        return {
          provider: createOpenAIProvider({ ...common, baseUrl: cfg.baseUrl || 'https://api.openai.com/v1', apiKey: cfg.apiKey, model: cfg.model }),
        };
      case 'anthropic':
        return {
          provider: createAnthropicProvider({ ...common, apiKey: cfg.apiKey, model: cfg.model || DEFAULT_ANTHROPIC_MODEL, effort: cfg.effort }),
        };
      case 'bridge':
        // No model in the buddy: the user's own AI app (Claude Code, Codex, Cursor, ...) is the
        // agent and talks to the buddy through the MCP server buddy/bridge-mcp.js.
        return { provider: { name: 'bridge', model: 'bridge', bridge: true } };
      case 'script':
        return { provider: createScriptProvider([{ text: 'Script-provider: er is geen model gekoppeld. Stel BUDDY_PROVIDER in.' }]) };
      case '':
        return {
          error:
            'Geen model ingesteld. Zet BUDDY_PROVIDER=bridge (je eigen AI-app met abonnement, via MCP), ' +
            'BUDDY_PROVIDER=openai (met BUDDY_MODEL, BUDDY_BASE_URL, BUDDY_API_KEY) of BUDDY_PROVIDER=anthropic, ' +
            'of maak buddy.config.json. Zie README › Buddy.',
        };
      default:
        return { error: `Onbekende BUDDY_PROVIDER "${cfg.provider}". Kies bridge, openai, anthropic of script.` };
    }
  } catch (e) {
    return { error: e.message };
  }
}
