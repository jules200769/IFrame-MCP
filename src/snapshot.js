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

export async function listFrames(session) {
  const frames = await session.frames();
  const mainOrigin = originOf(session.page.url());
  return Promise.all(
    frames.map(async ({ frame, id, depth }) => {
      const info = { id, depth, url: frame.url(), crossOrigin: originOf(frame.url()) !== mainOrigin, frame };
      try {
        info.box = await session.frameBox(frame);
        info.status = await session.call(frame, 'status');
      } catch (e) {
        info.error = e.message.split('\n')[0];
      }
      return info;
    }),
  );
}

export async function snapshot(session, { frame, max = 150, hidden = false } = {}) {
  let frames = await listFrames(session);
  if (frame !== undefined) frames = frames.filter((f) => f.id === frame);
  let budget = max;
  for (const f of frames) {
    if (f.error || budget <= 0) continue;
    try {
      const res = await session.call(f.frame, 'collect', { max: budget, hidden });
      const ox = f.box?.x || 0;
      const oy = f.box?.y || 0;
      f.items = res.items.map((it) => ({
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
      const kind = f.depth === 0 ? 'hoofdpagina' : f.crossOrigin ? 'iframe, cross-origin' : 'iframe';
      const st = f.status
        ? ` focus:${yn(f.status.hasFocus)} zichtbaar:${yn(!f.status.hidden)}${f.status.fullscreen ? ' fullscreen' : ''}`
        : '';
      return `${pad}[f${f.id}] ${f.url} (${kind})${box}${st}${f.error ? ` FOUT: ${f.error}` : ''}`;
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
      out.push(`${pad}  ${it.ref} ${it.role} "${it.name}"${state} @${x},${y} ${w}x${h}${it.overlay ? ' (onzichtbare laag)' : it.hidden ? ` (verborgen: ${it.why})` : ''}`);
    }
    if (f.truncated) out.push(`${pad}  … meer elementen; gebruik snapshot met frame=${f.id} of een hogere max`);
    if (f.summary) out.push(`${pad}  tekst: ${f.summary}`);
  }
  return out.join('\n');
}
