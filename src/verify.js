// Observing outcomes: fingerprints before/after an action, a readable diff, and
// explicit checks that poll until a condition holds.
import { parseRef } from './snapshot.js';

const PAUSE_EVENTS = new Set(['window-blur', 'hidden', 'pagehide', 'freeze']);
const norm = (line) => line.replace(/\d+([.,]\d+)?/g, '#');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fingerprintAll(session) {
  const frames = await session.frames();
  const out = {};
  await Promise.all(
    frames.map(async ({ frame, id }) => {
      try {
        out[id] = await session.call(frame, 'fingerprint');
      } catch {
        // Frame navigating or detached; it simply drops out of this fingerprint.
      }
    }),
  );
  return out;
}

const attrKey = (id) => `\u0000attrs:${id}`;

// Lines that change on their own (clocks, counters) are ignored when judging an action;
// so are attribute changes in frames that animate by themselves.
export function volatileKeys(a, b) {
  const keys = new Set();
  for (const id of Object.keys(b)) {
    if (!a[id]) continue;
    if (a[id].attrs !== b[id].attrs) keys.add(attrKey(id));
    const before = new Set(a[id].lines);
    const after = new Set(b[id].lines);
    for (const l of b[id].lines) if (!before.has(l)) keys.add(norm(l));
    for (const l of a[id].lines) if (!after.has(l)) keys.add(norm(l));
  }
  return keys;
}

export function diffFingerprints(before, after, volatile = new Set()) {
  const changes = [];
  let changed = false;
  let visualOnly = [];
  const add = (msg, real = true) => {
    changes.push(msg);
    if (real) changed = true;
  };
  for (const id of Object.keys(before)) if (!after[id]) add(`f${id}: frame verdwenen`);
  for (const [id, b] of Object.entries(after)) {
    const a = before[id];
    if (!a) {
      add(`f${id}: nieuw frame ${b.url}`);
      continue;
    }
    if (a.url !== b.url) add(`f${id}: url ${a.url} → ${b.url}`);
    if (!!a.fullscreen !== !!b.fullscreen) add(`f${id}: volledig scherm ${b.fullscreen ? 'aan' : 'uit'}`);
    if (a.viewport && b.viewport && a.viewport.join() !== b.viewport.join()) {
      add(`f${id}: formaat ${a.viewport.join('x')} → ${b.viewport.join('x')}`);
    }
    const prev = new Set(a.lines);
    const next = new Set(b.lines);
    const added = b.lines.filter((l) => !prev.has(l) && !volatile.has(norm(l)));
    const removed = a.lines.filter((l) => !next.has(l) && !volatile.has(norm(l)));
    for (const l of added.slice(0, 8)) add(`f${id}: tekst nieuw: "${l}"`);
    if (added.length > 8) add(`f${id}: … nog ${added.length - 8} nieuwe regels`);
    for (const l of removed.slice(0, 8)) add(`f${id}: tekst weg: "${l}"`);
    if (removed.length > 8) add(`f${id}: … nog ${removed.length - 8} verdwenen regels`);
    for (const [ref, s] of Object.entries(b.states)) {
      if (a.states[ref] !== undefined && a.states[ref] !== s) {
        add(`f${id}:e${ref} status: [${a.states[ref]}] → [${s}]`);
      }
    }
    const fa = a.focused ? `f${id}:e${a.focused.id}` : null;
    const fb = b.focused ? `f${id}:e${b.focused.id}` : null;
    if (fa !== fb && fb) add(`focus nu op ${fb} ${b.focused.role} "${b.focused.name}"`, false);
    if (a.hasFocus !== b.hasFocus) add(`f${id}: document focus ${a.hasFocus} → ${b.hasFocus}`, false);
    if (a.hidden !== b.hidden) add(`f${id}: verborgen ${a.hidden} → ${b.hidden}`, false);
    const dm = b.mutations - a.mutations;
    if (dm > 0) add(`f${id}: ${dm} DOM-wijzigingen`, false);
    if (a.attrs !== undefined && a.attrs !== b.attrs && !volatile.has(attrKey(id))) visualOnly.push(id);
  }
  // Attributes changed but no text/state did: likely a drawn change (e.g. an SVG checkmark).
  const maybe = !changed && visualOnly.length > 0;
  if (maybe) {
    for (const id of visualOnly) add(`f${id}: alleen visuele wijziging (attributen); controleer met screenshot`, false);
  }
  return { changed, maybe, changes };
}

// Two quick fingerprints to learn which lines tick by themselves.
export async function baseline(session) {
  const a = await fingerprintAll(session);
  await sleep(180);
  const b = await fingerprintAll(session);
  return { fp: b, volatile: volatileKeys(a, b) };
}

// Wait until the page stops changing (ignoring volatile lines), max ~2.5 s.
export async function settle(session, volatile, { min = 150, max = 2500 } = {}) {
  const start = Date.now();
  await sleep(min);
  let prev = await fingerprintAll(session);
  while (Date.now() - start < max) {
    await sleep(150);
    const cur = await fingerprintAll(session);
    const d = diffFingerprints(prev, cur, volatile);
    if (!d.changed && !d.maybe) return cur;
    prev = cur;
  }
  return prev;
}

export async function pauseEventsSince(session, since) {
  const frames = await session.frames();
  const out = [];
  for (const { frame, id } of frames) {
    try {
      const evs = await session.call(frame, 'eventsSince', since);
      for (const e of evs) out.push({ frame: `f${id}`, ...e });
    } catch {
      // ignore detached frames
    }
  }
  return out;
}

export const isPause = (e) => PAUSE_EVENTS.has(e.type);

async function checkOnce(session, expect) {
  const checks = [];
  const frames = await session.frames();
  const textIn = async (needle) => {
    for (const { frame, id } of frames) {
      if (await session.call(frame, 'hasText', needle).catch(() => false)) return `f${id}`;
    }
    return null;
  };
  if (expect.text) {
    const where = await textIn(expect.text);
    checks.push({ check: `tekst "${expect.text}" zichtbaar`, pass: !!where, evidence: where ? `gevonden in ${where}` : 'niet gevonden' });
  }
  if (expect.textGone) {
    const where = await textIn(expect.textGone);
    checks.push({ check: `tekst "${expect.textGone}" weg`, pass: !where, evidence: where ? `nog in ${where}` : 'niet meer aanwezig' });
  }
  if (expect.ref) {
    const { frameId, id } = parseRef(expect.ref);
    let state = null;
    try {
      state = await session.call(session.getFrame(frameId), 'stateOfId', id);
    } catch {
      // frame gone
    }
    const tokens = state === null ? null : state.split(' ');
    if (expect.refHas) {
      const pass = !!tokens && tokens.some((t) => t.startsWith(expect.refHas));
      checks.push({ check: `${expect.ref} heeft "${expect.refHas}"`, pass, evidence: state === null ? 'element bestaat niet meer' : `status [${state}]` });
    }
    if (expect.refLacks) {
      const pass = !!tokens && !tokens.some((t) => t.startsWith(expect.refLacks));
      checks.push({ check: `${expect.ref} mist "${expect.refLacks}"`, pass, evidence: state === null ? 'element bestaat niet meer' : `status [${state}]` });
    }
    if (!expect.refHas && !expect.refLacks) {
      checks.push({ check: `${expect.ref} bestaat`, pass: state !== null, evidence: state === null ? 'niet gevonden' : `status [${state}]` });
    }
  }
  if (expect.url) {
    const hit = frames.find(({ frame }) => frame.url().includes(expect.url));
    checks.push({ check: `url bevat "${expect.url}"`, pass: !!hit, evidence: hit ? `f${hit.id} ${hit.frame.url()}` : 'geen frame' });
  }
  if (expect.noPause) {
    const evs = (await pauseEventsSince(session, session.markAt)).filter(isPause);
    checks.push({
      check: 'app niet gepauzeerd of gesloten',
      pass: evs.length === 0,
      evidence: evs.length ? evs.map((e) => `${e.frame} ${e.type}`).join(', ') : 'geen blur/hidden/pagehide/freeze',
    });
  }
  return checks;
}

export async function verify(session, expect, timeoutMs = 4000) {
  const start = Date.now();
  let checks = [];
  do {
    checks = await checkOnce(session, expect);
    if (checks.length && checks.every((c) => c.pass)) break;
    await sleep(200);
  } while (Date.now() - start < timeoutMs);
  if (!checks.length) throw new Error('Geef minstens één verwachting op (text, textGone, ref+refHas/refLacks, url, noPause).');
  return { pass: checks.every((c) => c.pass), checks, ms: Date.now() - start };
}

export function formatVerify(res) {
  return [
    `Controle: ${res.pass ? 'GESLAAGD' : 'MISLUKT'} (${res.ms} ms)`,
    ...res.checks.map((c) => `- ${c.pass ? 'OK ' : 'NEE'} ${c.check}: ${c.evidence}`),
  ].join('\n');
}
