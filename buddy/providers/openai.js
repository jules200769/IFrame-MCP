// OpenAI-compatible Chat Completions (OpenAI, Ollama, LM Studio, OpenRouter, Groq, Mistral, Gemini's
// OpenAI endpoint, ...). Plain fetch, so any server that speaks /chat/completions with tools works.

export function toOpenAITools(tools) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

// Tool messages may only carry text; screenshots follow as one user message with image parts.
export function toOpenAIToolMessages(results, { vision = true } = {}) {
  const msgs = [];
  const images = [];
  for (const r of results) {
    const texts = [];
    for (const c of r.content) {
      if (c.type === 'text') texts.push(c.text);
      else if (c.type === 'image') {
        if (vision) {
          images.push(c);
          texts.push('(screenshot volgt in het volgende bericht)');
        } else texts.push('(screenshot niet doorgegeven: dit model krijgt geen beelden)');
      }
    }
    msgs.push({ role: 'tool', tool_call_id: r.id, content: texts.join('\n') || '(leeg)' });
  }
  if (images.length) {
    msgs.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Screenshot uit de laatste tool-aanroep:' },
        ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
      ],
    });
  }
  return msgs;
}

export function parseToolCalls(toolCalls = []) {
  return toolCalls.map((tc) => {
    const name = tc.function?.name;
    const raw = tc.function?.arguments;
    let args = {};
    let error;
    if (raw && typeof raw === 'object') args = raw;
    else if (raw) {
      try {
        args = JSON.parse(raw);
      } catch {
        error = `Fout: de argumenten voor ${name} zijn geen geldige JSON. Probeer het opnieuw.`;
      }
    }
    return { id: tc.id, name, args, error };
  });
}

export function createOpenAIProvider({ baseUrl, apiKey, model, system, tools, vision = true, fetchImpl = fetch }) {
  if (!model) throw new Error('BUDDY_MODEL ontbreekt (bv. gpt-4.1 of qwen2.5:14b).');
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const oaTools = toOpenAITools(tools);
  let messages = [{ role: 'system', content: system }];

  return {
    name: 'openai',
    model,
    addUser(text) {
      messages.push({ role: 'user', content: text });
    },
    async turn({ signal } = {}) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages, tools: oaTools, tool_choice: 'auto' }),
        signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Model-API ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('Model-API gaf geen bericht terug.');
      const assistant = { role: 'assistant', content: msg.content ?? null };
      if (msg.tool_calls?.length) assistant.tool_calls = msg.tool_calls;
      messages.push(assistant);
      return { text: typeof msg.content === 'string' ? msg.content.trim() : '', toolCalls: parseToolCalls(msg.tool_calls) };
    },
    addToolResults(results) {
      messages.push(...toOpenAIToolMessages(results, { vision }));
    },
    reset() {
      messages = [{ role: 'system', content: system }];
    },
    get messages() {
      return messages;
    },
  };
}
