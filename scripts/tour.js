// One pass of the demo playground, using the same functions as the MCP tools.
import { Session } from '../src/browser.js';
import { snapshot, formatSnapshot } from '../src/snapshot.js';
import { act, clickXY, formatOutcome } from '../src/actions.js';
import { verify, formatVerify } from '../src/verify.js';

const session = new Session({ cdpUrl: process.env.CDP_URL || 'http://127.0.0.1:9222' });
const steps = [];

function find(snap, name, pred = () => true) {
  for (const f of snap.frames) {
    for (const it of f.items || []) {
      if (it.name === name && pred(it, f)) return it;
    }
  }
  return null;
}

async function step(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    steps.push({ name, ok: true, ms: Date.now() - t, detail });
    console.log(`\nOK ${name} (${Date.now() - t} ms)\n${detail}`);
  } catch (e) {
    const detail = e.message.split('\n')[0];
    steps.push({ name, ok: false, ms: Date.now() - t, detail });
    console.log(`\nFAIL ${name} (${Date.now() - t} ms)\n${detail}`);
  }
}

await session.connect();
const page = await session.currentPage();
await page.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 20000 });
await page.bringToFront();
session.markAt = Date.now();

let snap;
await step('snapshot', async () => {
  snap = await snapshot(session, { max: 400, hidden: true });
  const names = snap.frames.flatMap((f) => (f.items || []).map((i) => `${i.ref} ${i.role} "${i.name}"${i.hidden ? ' HIDDEN' : ''}${i.overlay ? ' OVERLAY' : ''}`));
  return formatSnapshot(snap) + `\n--- ${names.length} items ---\n` + names.join('\n');
});

async function clickName(name, action = 'click', value) {
  snap = await snapshot(session, { max: 400, hidden: true });
  const it = find(snap, name);
  if (!it) throw new Error(`niet in snapshot: ${name}`);
  const res = await act(session, { ref: it.ref, action, value });
  return formatOutcome(res);
}

await step('stad Utrecht', () => clickName('Utrecht'));
await step('volgende dag', () => clickName('Volgende dag'));
await step('verify morgen', async () => {
  const res = await verify(session, { text: 'Utrecht morgen: 14°C' }, 2000);
  const detail = formatVerify(res);
  if (!res.pass) throw new Error(detail);
  return detail;
});
await step('gevoelstemperatuur', () => clickName('Gevoelstemperatuur'));
await step('favoriet', async () => {
  snap = await snapshot(session, { max: 400 });
  const it = snap.frames.flatMap((f) => f.items || []).find((i) => i.role === 'clickable' && i.rect[2] <= 40 && i.rect[3] <= 40 && !i.name);
  if (!it) throw new Error('favoriet-ster niet in snapshot');
  return formatOutcome(await act(session, { ref: it.ref }));
});

await step('gewone knop', () => clickName('Gewone knop'));
await step('toggle', () => clickName('Toggle'));
await step('alleen echt', () => clickName('Alleen echt'));
await step('dubbelklik', () => clickName('Dubbelklik', 'dblclick'));
await step('uitgeschakeld', async () => {
  const detail = await clickName('Uitgeschakeld');
  if (!detail.includes('uitgeschakeld')) throw new Error(detail.split('\n')[0]);
  return detail;
});
await step('radio regen', () => clickName('Regen'));
await step('regio midden', () => clickName('Regio', 'select', 'midden'));
await step('wind', async () => {
  snap = await snapshot(session, { max: 400 });
  const it = snap.frames.flatMap((f) => f.items || []).find((i) => i.role === 'range' || i.name === 'Wind');
  if (!it) throw new Error('range niet in snapshot');
  const res = await act(session, { ref: it.ref, action: 'fill', value: '8' });
  return formatOutcome(res) + `\nref ${it.ref} ${it.role} "${it.name}"`;
});
await step('samenvatting', () => clickName('Toon samenvatting'));
await step('bedekt', () => clickName('Verborgen actie'));
await step('open shadow', () => clickName('Open shadow'));
await step('closed shadow', () => clickName('Closed shadow'));
await step('nested', () => clickName('In nested'));
await step('dialoog open', () => clickName('Open dialoog'));
await step('dialoog bevestigen', () => clickName('Bevestigen'));
await step('canvas', async () => {
  snap = await snapshot(session, { max: 400 });
  const it = snap.frames.flatMap((f) => f.items || []).find((i) => i.role === 'canvas');
  if (!it) throw new Error('canvas niet in snapshot');
  const [x, y, w, h] = it.rect;
  const res = await clickXY(session, { x: x + Math.round(w * 0.25), y: y + Math.round(h / 2) });
  return formatOutcome(res);
});
await step('geen pauze', async () => {
  const res = await verify(session, { noPause: true }, 0);
  const detail = formatVerify(res);
  if (!res.pass) throw new Error(detail);
  return detail;
});

const failed = steps.filter((s) => !s.ok);
console.log(`\n=== ${steps.length - failed.length}/${steps.length} geslaagd, ${steps.reduce((a, s) => a + s.ms, 0)} ms ===`);
if (failed.length) {
  console.log(failed.map((s) => `- ${s.name}: ${s.detail}`).join('\n'));
  process.exitCode = 1;
}
await session.close();
