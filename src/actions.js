// Trusted input (real CDP mouse/keyboard events) plus an automatic outcome report.
import { parseRef } from './snapshot.js';
import { baseline, settle, diffFingerprints, pauseEventsSince, isPause } from './verify.js';

async function resolve(session, ref) {
  const { frameId, id } = parseRef(ref);
  const frame = session.getFrame(frameId);
  const el = await session.elementFor(frame, id);
  if (!el) throw new Error(`${ref} bestaat niet meer. Maak een nieuwe snapshot.`);
  return { frame, el };
}

const short = (e) => e.message.split('\n')[0].slice(0, 140);

async function centerClick(page, el, opts = {}) {
  const box = await el.boundingBox();
  if (!box) throw new Error('element heeft geen positie op het scherm');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y, opts);
  return `${Math.round(x)},${Math.round(y)}`;
}

async function coveredOrInvisible(el) {
  await el.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
  return el
    .evaluate((e) => {
      if (e.checkVisibility && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return true;
      const r = e.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!top && top !== e && !e.contains(top) && !top.contains(e);
    })
    .catch(() => false);
}

// Run an input step and report what changed in all frames.
async function withOutcome(session, run) {
  const page = await session.currentPage();
  const t0 = Date.now();
  session.lastActionAt = t0;
  const { fp: before, volatile } = await baseline(session);
  const pagesBefore = new Set(session.context.pages());
  const how = await run(page);
  const after = await settle(session, volatile);
  const diff = diffFingerprints(before, after, volatile);
  // Links/buttons that open a new tab or window push the app tab to the background,
  // where Chrome stops rendering it (screenshots hang, some apps pause).
  const opened = session.context.pages().filter((p) => !pagesBefore.has(p));
  for (const p of opened) {
    await p.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
    const index = session.context.pages().indexOf(p);
    diff.changes.push(`nieuwe tab ${index} geopend: ${p.url()} (de app-tab staat nu mogelijk niet vooraan; tabs met close=${index} of front=true)`);
    diff.changed = true;
    diff.maybe = false;
  }
  const pauses = (await pauseEventsSince(session, t0)).filter(isPause);
  return { how, ...diff, pauses, opened: opened.map((p) => p.url()) };
}

export async function act(session, { ref, action = 'click', value }) {
  const { el } = await resolve(session, ref);
  try {
    return await withOutcome(session, async (page) => {
      switch (action) {
        case 'click':
        case 'dblclick': {
          const opts = action === 'dblclick' ? { clickCount: 2 } : {};
          // Invisible or covered controls (accessibility layers under/over drawn shapes):
          // click their centre straight away instead of waiting for Playwright's checks.
          if (await coveredOrInvisible(el)) {
            const at = await centerClick(page, el, opts);
            return `${action} met echte muisinvoer op het midden van ${ref} (${at}); element is onzichtbaar of bedekt door de getekende laag`;
          }
          try {
            await el[action]({ timeout: 2500 });
            return `${action} met echte muisinvoer op ${ref}`;
          } catch (e) {
            const at = await centerClick(page, el, opts);
            return `${action} met echte muisinvoer op het midden van ${ref} (${at}) na: ${short(e)}`;
          }
        }
        case 'hover':
          await el.hover({ timeout: 2500 });
          return `hover op ${ref}`;
        case 'fill':
          try {
            await el.fill(String(value ?? ''), { timeout: 2500 });
            return `veld ${ref} gevuld`;
          } catch {
            await el.click({ timeout: 2500 }).catch(() => centerClick(page, el));
            await page.keyboard.press('Control+A');
            await page.keyboard.type(String(value ?? ''), { delay: 15 });
            return `veld ${ref} gevuld via toetsenbord (terugval)`;
          }
        case 'type':
          await el.focus();
          await page.keyboard.type(String(value ?? ''), { delay: 15 });
          return `getypt in ${ref}`;
        case 'press':
          await el.press(String(value || 'Enter'), { timeout: 2500 });
          return `toets ${value || 'Enter'} op ${ref}`;
        case 'select':
          await el.selectOption(String(value), { timeout: 2500 });
          return `optie "${value}" gekozen in ${ref}`;
        case 'check':
        case 'uncheck':
          try {
            await el[action]({ timeout: 2500 });
            return `${action} op ${ref}`;
          } catch (e) {
            const at = await centerClick(page, el);
            return `${action} met echte muisinvoer op het midden van ${ref} (${at}) na: ${short(e)}`;
          }
        case 'focus':
          await el.focus();
          return `focus op ${ref}`;
        default:
          throw new Error(`Onbekende actie "${action}".`);
      }
    });
  } finally {
    await el.dispose().catch(() => {});
  }
}

export function clickXY(session, { x, y, double = false }) {
  return withOutcome(session, async (page) => {
    await page.mouse.click(x, y, double ? { clickCount: 2 } : {});
    return `klik met echte muisinvoer op coördinaat ${x},${y}`;
  });
}

export function press(session, { key }) {
  return withOutcome(session, async (page) => {
    await page.keyboard.press(key);
    return `toets ${key} naar het element met focus`;
  });
}

export function formatOutcome(res) {
  const verdict = res.changed ? 'VERANDERD' : res.maybe ? 'MOGELIJK VERANDERD (alleen visueel)' : 'GEEN ZICHTBARE VERANDERING';
  const lines = [`Actie: ${res.how}`, `Resultaat: ${verdict}`];
  for (const c of res.changes) lines.push(`- ${c}`);
  lines.push(
    res.pauses.length
      ? `Let op, app-events: ${res.pauses.map((p) => `${p.frame} ${p.type}`).join(', ')}`
      : 'App-events: geen blur/pauze',
  );
  if (res.maybe) lines.push('Tip: maak een screenshot van het frame om te zien of het gelukt is; klik niet meteen opnieuw (dat kan het weer uitzetten).');
  else if (!res.changed) lines.push('Tip: snapshot opnieuw (ook onzichtbare laag), toetsenbord (press Space/Enter), of click_xy na een screenshot.');
  return lines.join('\n');
}

// Screenshot of just the region that matters (frame or element), as JPEG, with a hard timeout.
export async function screenshot(session, { ref, frame, quality = 60 }) {
  const page = await session.currentPage();
  let box;
  if (ref) {
    const r = await resolve(session, ref);
    box = await r.el.boundingBox();
    await r.el.dispose();
  } else if (frame !== undefined) {
    box = await session.frameBox(session.getFrame(frame));
  }
  const vp = await page.evaluate(() => ({
    w: innerWidth,
    h: innerHeight,
    left: visualViewport ? visualViewport.pageLeft : scrollX,
    top: visualViewport ? visualViewport.pageTop : scrollY,
  }));
  if (!box || !box.width) box = { x: 0, y: 0, width: vp.w, height: vp.h };
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const clip = {
    x: x + vp.left,
    y: y + vp.top,
    width: Math.max(1, Math.min(box.x + box.width, vp.w) - x),
    height: Math.max(1, Math.min(box.y + box.height, vp.h) - y),
    scale: 1,
  };
  const cdp = await session.cdp();
  const shot = cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, clip, captureBeyondViewport: false });
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('Screenshot duurde langer dan 6 s: staat er een andere tab vooraan (tabs front=true) of is het venster geminimaliseerd? Snapshot werkt wel.')), 6000),
  );
  const { data } = await Promise.race([shot, timeout]);
  return { data, clip };
}
