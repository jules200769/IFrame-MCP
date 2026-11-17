// What the buddy may do on its own. Three modes:
//   kijken  - only look: reading tools run, anything that changes the page is refused
//   vragen  - every action waits for the user's OK in the buddy window
//   zelf    - actions run straight away (the original behaviour)
// Shared by the model loop (agent.js) and the bridge (server.js), so both obey the same gate.
import { runTool } from '../src/tools.js';

export const MODES = ['kijken', 'vragen', 'zelf'];

// Read-only tools. Anything not listed here counts as an action (safe default for new tools).
const READ_ONLY = new Set(['snapshot', 'frames', 'screenshot', 'verify', 'app_events', 'look']);

export function isMutating(name, args = {}) {
  if (name === 'tabs') return args.close !== undefined || !!args.front;
  return !READ_ONLY.has(name);
}

const text = (t) => [{ type: 'text', text: t }];
const refused = (t) => ({ isError: true, content: text(t) });

export const REFUSED_LOOK_ONLY =
  'Niet uitgevoerd: de buddy staat op "kijken" (alleen meekijken). Leg uit wat de gebruiker kan doen, of vraag of de modus op "vragen" of "zelf" mag.';
export const REFUSED_BY_USER = 'Niet uitgevoerd: de gebruiker weigerde deze actie.';
export const STOPPED = 'Niet uitgevoerd: gestopt door de gebruiker.';

const firstText = (content, n = 600) => {
  const t = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// Runs one tool call through the mode gate and reports it to the UI (tool_start/tool_end,
// approval/approval_done). Returns an MCP-style result { isError, content }.
export class CallRunner {
  constructor({ session, emit = () => {}, run = runTool, extraTools = [], ctx, mode = 'zelf' }) {
    if (!MODES.includes(mode)) throw new Error(`Onbekende modus "${mode}". Kies ${MODES.join(', ')}.`);
    this.session = session;
    this.emit = emit;
    this.run = run;
    this.extraTools = extraTools;
    this.ctx = ctx;
    this.mode = mode;
    this.pending = new Map(); // approval id -> { resolve, call }
    this.nextId = 1;
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error(`Onbekende modus "${mode}". Kies ${MODES.join(', ')}.`);
    this.mode = mode;
    if (mode !== 'vragen') {
      // Switching away from "vragen" answers what is waiting: zelf = allow, kijken = refuse.
      for (const id of [...this.pending.keys()]) this.answer(id, mode === 'zelf');
    }
  }

  requestApproval(call, signal) {
    const id = `a${this.nextId++}`;
    return new Promise((resolve) => {
      const done = (allow) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        this.emit({ type: 'approval_done', id, allow });
        resolve(allow);
      };
      const onAbort = () => done(false);
      this.pending.set(id, { done, call });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.emit({ type: 'approval', id, name: call.name, args: call.args ?? {} });
      if (signal?.aborted) onAbort();
    });
  }

  answer(id, allow) {
    const p = this.pending.get(id);
    if (!p) return false;
    p.done(!!allow);
    return true;
  }

  denyAll() {
    for (const id of [...this.pending.keys()]) this.answer(id, false);
  }

  get waiting() {
    return [...this.pending.entries()].map(([id, p]) => ({ id, name: p.call.name, args: p.call.args ?? {} }));
  }

  async runCall(call, { signal } = {}) {
    if (signal?.aborted) return refused(STOPPED);
    if (call.error) return refused(call.error);
    if (isMutating(call.name, call.args)) {
      if (this.mode === 'kijken') {
        this.emit({ type: 'tool_end', id: call.id, name: call.name, args: call.args, isError: true, summary: REFUSED_LOOK_ONLY });
        return refused(REFUSED_LOOK_ONLY);
      }
      if (this.mode === 'vragen' && !(await this.requestApproval(call, signal))) {
        const why = signal?.aborted ? STOPPED : REFUSED_BY_USER;
        this.emit({ type: 'tool_end', id: call.id, name: call.name, args: call.args, isError: true, summary: why });
        return refused(why);
      }
    }
    this.emit({ type: 'tool_start', id: call.id, name: call.name, args: call.args });
    const res = await this.run(this.session, call.name, call.args, { extraTools: this.extraTools, ctx: this.ctx });
    const image = res.content.find((c) => c.type === 'image');
    this.emit({
      type: 'tool_end',
      id: call.id,
      name: call.name,
      isError: !!res.isError,
      summary: firstText(res.content),
      image: image ? { data: image.data, mimeType: image.mimeType } : undefined,
    });
    return res;
  }
}
