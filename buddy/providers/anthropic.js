// Anthropic Messages API via the official SDK. The full response.content goes back into the
// history unchanged (thinking blocks included); each tool_use gets exactly one tool_result.
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
// Models that accept server-side fallbacks with fallbacks: "default".
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export function toAnthropicTools(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

export function toAnthropicToolResults(results, { vision = true } = {}) {
  return results.map((r) => ({
    type: 'tool_result',
    tool_use_id: r.id,
    ...(r.isError ? { is_error: true } : {}),
    content: r.content.map((c) =>
      c.type === 'image'
        ? vision
          ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } }
          : { type: 'text', text: '(screenshot niet doorgegeven: dit model krijgt geen beelden)' }
        : { type: 'text', text: c.text || '(leeg)' },
    ),
  }));
}

export function buildAnthropicRequest({ model, system, tools, messages, effort }) {
  const req = { model, max_tokens: 16000, system, tools: toAnthropicTools(tools), messages };
  if (effort && !/haiku-4/.test(model)) req.output_config = { effort };
  if (FALLBACK_MODELS.has(model)) {
    req.betas = ['server-side-fallback-2026-07-01'];
    req.fallbacks = 'default';
  }
  return req;
}

export function createAnthropicProvider({ apiKey, model = DEFAULT_ANTHROPIC_MODEL, system, tools, vision = true, effort = 'medium', client }) {
  const sdk = client ?? new Anthropic(apiKey ? { apiKey } : {});
  let messages = [];

  return {
    name: 'anthropic',
    model,
    addUser(text) {
      messages.push({ role: 'user', content: text });
    },
    async turn({ signal } = {}) {
      const req = buildAnthropicRequest({ model, system, tools, messages, effort });
      const response = req.betas
        ? await sdk.beta.messages.create(req, { signal })
        : await sdk.messages.create(req, { signal });

      if (response.stop_reason === 'refusal') {
        const cat = response.stop_details?.category;
        return { text: `Het model weigerde dit verzoek${cat ? ` (${cat})` : ''}.`, toolCalls: [] };
      }
      if (response.content.length) messages.push({ role: 'assistant', content: response.content });

      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const truncated = response.stop_reason === 'max_tokens';
      const toolCalls = response.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          name: b.name,
          args: b.input,
          error: truncated ? 'Fout: het antwoord werd afgekapt (max_tokens); deze tool-aanroep is niet uitgevoerd.' : undefined,
        }));
      return { text, toolCalls };
    },
    addToolResults(results) {
      messages.push({ role: 'user', content: toAnthropicToolResults(results, { vision }) });
    },
    reset() {
      messages = [];
    },
    get messages() {
      return messages;
    },
  };
}
