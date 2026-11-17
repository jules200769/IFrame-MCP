import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFingerprints, volatileKeys } from '../src/verify.js';
import { parseRef } from '../src/snapshot.js';

const fp = (lines, states = {}, extra = {}) => ({
  url: 'http://x/', lines, states, focused: null, hasFocus: true, hidden: false, mutations: 0, ...extra,
});

test('parseRef reads frame and element ids', () => {
  assert.deepEqual(parseRef('f2:e15'), { frameId: 2, id: 15 });
  assert.throws(() => parseRef('e15'));
});

test('diff reports new text and state changes', () => {
  const d = diffFingerprints(
    { 1: fp(['Kies een stad.'], { 3: '' }) },
    { 1: fp(['Utrecht vandaag: 12°C'], { 3: 'active-class' }) },
  );
  assert.equal(d.changed, true);
  assert.ok(d.changes.some((c) => c.includes('tekst nieuw: "Utrecht vandaag: 12°C"')));
  assert.ok(d.changes.some((c) => c.includes('f1:e3 status')));
});

test('ticking lines learned as volatile are ignored', () => {
  const a = { 1: fp(['Looptijd: 1.0 s', 'Kies een stad.']) };
  const b = { 1: fp(['Looptijd: 1.2 s', 'Kies een stad.']) };
  const c = { 1: fp(['Looptijd: 3.4 s', 'Kies een stad.']) };
  const d = diffFingerprints(b, c, volatileKeys(a, b));
  assert.equal(d.changed, false);
});

test('entering fullscreen counts as a change', () => {
  const d = diffFingerprints(
    { 0: fp(['x'], {}, { fullscreen: false, viewport: [1000, 700] }), 1: fp(['y'], {}, { viewport: [1000, 560] }) },
    { 0: fp(['x'], {}, { fullscreen: true, viewport: [1000, 700] }), 1: fp(['y'], {}, { viewport: [1036, 703] }) },
  );
  assert.equal(d.changed, true);
  assert.ok(d.changes.includes('f0: volledig scherm aan'));
  assert.ok(d.changes.includes('f1: formaat 1000x560 → 1036x703'));
});

test('attribute-only change is "maybe", unless the frame animates by itself', () => {
  const a = { 1: fp(['x'], {}, { attrs: 1 }) };
  const b = { 1: fp(['x'], {}, { attrs: 2 }) };
  const d = diffFingerprints(a, b);
  assert.equal(d.changed, false);
  assert.equal(d.maybe, true);
  const animating = volatileKeys({ 1: fp(['x'], {}, { attrs: 7 }) }, { 1: fp(['x'], {}, { attrs: 8 }) });
  assert.equal(diffFingerprints(a, b, animating).maybe, false);
});

test('focus and mutation counts alone do not count as a change', () => {
  const d = diffFingerprints({ 0: fp(['x']) }, { 0: fp(['x'], {}, { mutations: 5 }) });
  assert.equal(d.changed, false);
  assert.ok(d.changes[0].includes('5 DOM-wijzigingen'));
});
