// Deterministic provider for tests and offline demos. Each step is a turn:
// { text?, calls?: [{ name, args }] } or a function (history) => turn, where history holds the
// tool results returned so far ([{ name, args, isError, text }]).
export function createScriptProvider(steps = []) {
  let i = 0;
  let calls = 0;
  const history = [];
  let pending = [];

  return {
    name: 'script',
    model: 'script',
    users: [],
    history,
    addUser(text) {
      this.users.push(text);
    },
    async turn() {
      const step = steps[i++] ?? { text: '(script klaar)' };
      const t = typeof step === 'function' ? await step(history) : step;
      pending = (t.calls || []).map((c) => ({ id: `call_${++calls}`, name: c.name, args: c.args ?? {} }));
      return { text: t.text || '', toolCalls: pending };
    },
    addToolResults(results) {
      for (const r of results) {
        const call = pending.find((p) => p.id === r.id);
        history.push({
          name: r.name,
          args: call?.args,
          isError: !!r.isError,
          text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
          images: r.content.filter((c) => c.type === 'image').length,
        });
      }
    },
    reset() {
      i = 0;
      history.length = 0;
      this.users.length = 0;
    },
  };
}

// Find the ref of an element by its quoted name in snapshot text, e.g. `f1:e3 clickable "Utrecht"`.
export function refByName(snapshotText, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(f\\d+:e\\d+) \\S+ "${esc}"`).exec(snapshotText)?.[1] ?? null;
}
