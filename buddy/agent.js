// Provider-neutral agent loop: model turn → run tool calls → hand results back → repeat.
// Tool calls go through a CallRunner (buddy/policy.js), which applies the mode
// (kijken / vragen / zelf) and reports each step to the UI.
import { runTool } from '../src/tools.js';
import { CallRunner, STOPPED } from './policy.js';

export class BuddyAgent {
  constructor({ session, provider, emit = () => {}, maxSteps = 25, run = runTool, runner }) {
    this.provider = provider;
    this.emit = emit;
    this.maxSteps = maxSteps;
    this.runner = runner ?? new CallRunner({ session, emit, run });
    this.busy = false;
    this.ac = null;
  }

  stop() {
    this.ac?.abort();
    this.runner.denyAll();
  }

  reset() {
    this.stop();
    this.provider.reset();
  }

  async send(text) {
    if (this.busy) throw new Error('De buddy is nog bezig; wacht of druk op Stop.');
    this.busy = true;
    this.ac = new AbortController();
    const { signal } = this.ac;
    let outcome = 'done';
    try {
      this.provider.addUser(text);
      for (let step = 0; ; step++) {
        if (step >= this.maxSteps) {
          this.emit({ type: 'error', text: `Gestopt na ${this.maxSteps} stappen. Geef een kleinere opdracht of zeg "ga door".` });
          break;
        }
        const turn = await this.provider.turn({ signal });
        if (turn.text) this.emit({ type: 'assistant', text: turn.text });
        if (!turn.toolCalls?.length) break;

        // Every tool call gets a result, also after Stop: providers require one per call.
        const results = [];
        for (const call of turn.toolCalls) {
          const res = signal.aborted
            ? { isError: true, content: [{ type: 'text', text: STOPPED }] }
            : await this.runner.runCall(call, { signal });
          results.push({ id: call.id, name: call.name, ...res });
        }
        this.provider.addToolResults(results);
        if (signal.aborted) break;
      }
      if (signal.aborted) outcome = 'stopped';
    } catch (e) {
      if (signal.aborted) {
        outcome = 'stopped';
      } else {
        outcome = 'error';
        this.emit({ type: 'error', text: String(e?.message || e).split('\n')[0] });
      }
    } finally {
      this.busy = false;
      this.ac = null;
      this.emit({ type: 'done', outcome });
    }
    return outcome;
  }
}
