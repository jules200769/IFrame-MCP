// Frame-aware view of the page: every frame (also cross-origin iframes) in one list.

export function parseRef(ref) {
  const m = /^f(\d+):e(\d+)$/.exec(String(ref).trim());
  if (!m) throw new Error(`Ongeldige ref "${ref}". Verwacht bijvoorbeeld f1:e3.`);
  return { frameId: Number(m[1]), id: Number(m[2]) };
}

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

// How the frame element is embedded: sandbox, srcdoc, inside a shadow root.
async function embedding(frame) {
  if (!frame.parentFrame()) return {};
  const el = await frame.frameElement().catch(() => null);
  if (!el) return {};
  try {
    return await el.evaluate((e) => ({
      sandbox: e.hasAttribute('sandbox') ? e.getAttribute('sandbox') : null,
      srcdoc: e.hasAttribute('srcdoc'),
      inShadow: e.getRootNode() instanceof ShadowRoot,
      title: e.getAttribute('title') || '',
    }));
  } catch {
    return {};
  } finally {
    await el.dispose().catch(() => {});
  }
}

export async function listFrames(session) {
  const frames = await session.frames();
  const mainOrigin = originOf(session.page.url());
  return Promise.all(
    frames.map(async ({ frame, id, depth }) => {
      const info = { id, depth, url: frame.url(), frame };
      try {
        info.box = await session.frameBox(frame);
        info.embed = await embedding(frame);
        // The real origin: about:blank/srcdoc inherit it, data: and sandboxed frames are opaque ("null").
        info.status = await session.call(frame, 'status');
        info.origin = info.status?.origin;
      } catch (e) {
        info.error = e.message.split('\n')[0];
      }
      info.crossOrigin = (info.origin ?? originOf(frame.url())) !== mainOrigin;
      return info;
    }),
  );
}

export function frameKind(f) {
  if (f.depth === 0) return 'hoofdpagina';
  const parts = ['iframe'];
  const u = f.url || '';
  if (u === 'about:srcdoc' || f.embed?.srcdoc) parts.push('srcdoc');
  else if (u.startsWith('about:blank')) parts.push('about:blank');
  else if (u.startsWith('data:')) parts.push('data:');
  else if (u.startsWith('blob:')) parts.push('blob:');
  if (f.embed?.sandbox !== null && f.embed?.sandbox !== undefined) parts.push(`sandbox="${f.embed.sandbox}"`);
  if (f.embed?.inShadow) parts.push('in shadow DOM');
  if (f.origin === 'null') parts.push('opaque origin');
  else if (f.crossOrigin) parts.push('cross-origin');
  return parts.join(', ');
}

const shortUrl = (u) => (u.length > 90 ? `${u.slice(0, 87)}…` : u);

export async function snapshot(session, { frame, max = 150, hidden = false } = {}) {
  let frames = await listFrames(session);
  if (frame !== undefined) frames = frames.filter((f) => f.id === frame);
  let budget = max;
  for (const f of frames) {
    if (f.error || budget <= 0) continue;
    try {
      const res = await session.call(f.frame, 'collect', { max: budget, hidden });
      const extra = await session.closedShadowItems(f.frame, { hidden });
      const ox = f.box?.x || 0;
      const oy = f.box?.y || 0;
      const seen = new Set(res.items.map((it) => it.id));
      const merged = res.items.concat(extra.filter((it) => !seen.has(it.id)));
      f.items = merged.map((it) => ({
        ...it,
        ref: `f${f.id}:e${it.id}`,
        rect: [it.rect[0] + Math.round(ox), it.rect[1] + Math.round(oy), it.rect[2], it.rect[3]],
      }));
      f.truncated = res.truncated;
      budget -= f.items.length;
      f.summary = await session.call(f.frame, 'summary', 500);
    } catch (e) {
      f.error = e.message.split('\n')[0];
    }
  }
  return { page: { title: await session.page.title(), url: session.page.url() }, frames };
}

const yn = (b) => (b ? 'ja' : 'nee');

export function formatFrames(frames) {
  return frames
    .map((f) => {
      const pad = '  '.repeat(f.depth);
      const box = f.box && f.box.width ? ` @${Math.round(f.box.x)},${Math.round(f.box.y)} ${Math.round(f.box.width)}x${Math.round(f.box.height)}` : '';
      const st = f.status
        ? ` focus:${yn(f.status.hasFocus)} zichtbaar:${yn(!f.status.hidden)}${f.status.fullscreen ? ' fullscreen' : ''}`
        : '';
      const err = f.error ? ` niet uitleesbaar: ${f.error} → gebruik screenshot frame=${f.id} en click_xy` : '';
      return `${pad}[f${f.id}] ${shortUrl(f.url)} (${frameKind(f)})${box}${st}${err}`;
    })
    .join('\n');
}

export function formatSnapshot(snap) {
  const out = [`Tab: ${snap.page.title} — ${snap.page.url}`];
  for (const f of snap.frames) {
    const pad = '  '.repeat(f.depth);
    out.push(formatFrames([f]));
    for (const it of f.items || []) {
      const state = it.state.length ? ` [${it.state.join(' ')}]` : '';
      const [x, y, w, h] = it.rect;
      const where = it.closedShadow ? ' (gesloten shadow)' : '';
      out.push(`${pad}  ${it.ref} ${it.role} "${it.name}"${state} @${x},${y} ${w}x${h}${it.overlay ? ' (onzichtbare laag)' : it.hidden ? ` (verborgen: ${it.why})` : ''}${where}`);
    }
    if (f.truncated) out.push(`${pad}  … meer elementen; gebruik snapshot met frame=${f.id} of een hogere max`);
    if (f.summary) out.push(`${pad}  tekst: ${f.summary}`);
  }
  return out.join('\n');
}
