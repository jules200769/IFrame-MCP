// Tool definitions shared by the MCP server (src/server.js) and the buddy (buddy/agent.js).
// Each tool returns MCP-style content: [{type:'text',text}] or [{type:'image',data,mimeType}, ...].
import { z } from 'zod';
import { listFrames, snapshot, formatFrames, formatSnapshot } from './snapshot.js';
import { act, clickXY, press, screenshot, formatOutcome } from './actions.js';
import { verify, formatVerify, pauseEventsSince } from './verify.js';

const text = (t) => [{ type: 'text', text: t }];

export const TOOLS = [
  {
    name: 'tabs',
    description:
      'Lijst de open tabs. select=<index> kiest de tab waarin de agent werkt; front=true zet die tab vooraan ' +
      '(nodig voor renderen/screenshots); close=<index> sluit een tab (bv. een tab die een actie opende).',
    schema: z.object({
      select: z.number().int().optional(),
      front: z.boolean().optional(),
      close: z.number().int().optional(),
    }),
    async run(session, { select, front, close }) {
      let pages = session.context.pages();
      if (close !== undefined) {
        if (!pages[close]) throw new Error(`Geen tab ${close}.`);
        if (pages[close] === session.page) throw new Error('Dat is de tab waarin de agent werkt; kies eerst een andere.');
        await pages[close].close();
        pages = session.context.pages();
      }
      if (select !== undefined) {
        if (!pages[select]) throw new Error(`Geen tab ${select}.`);
        await session.selectPage(pages[select]);
      }
      if (front || close !== undefined) await (await session.currentPage()).bringToFront();
      const cur = await session.currentPage();
      const rows = await Promise.all(
        pages.map(async (p, i) => `${p === cur ? '*' : ' '} ${i}: ${await p.title().catch(() => '')} — ${p.url()}`),
      );
      return text(rows.join('\n'));
    },
  },
  {
    name: 'open',
    description: 'Open een URL in de huidige tab (of newTab=true voor een nieuwe tab).',
    schema: z.object({ url: z.string(), newTab: z.boolean().optional() }),
    async run(session, { url, newTab }) {
      if (newTab) {
        const page = await session.context.newPage();
        if (session.kind === 'dedicated') await session.preparePage(page).catch(() => {});
        await session.selectPage(page);
      }
      const page = await session.currentPage();
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
      return text(`Geopend: ${await page.title()} — ${page.url()}`);
    },
  },
  {
    name: 'frames',
    description: 'Lijst alle frames van de tab (ook cross-origin iframes) met positie, focus en zichtbaarheid.',
    schema: z.object({}),
    run: async (session) => text(formatFrames(await listFrames(session))),
  },
  {
    name: 'snapshot',
    description:
      'Toon bedienbare elementen in ALLE frames, met refs als f1:e3 en een korte tekst per frame. ' +
      'Bevat ook niet-semantische klikdoelen van eigen players (role "clickable") en onzichtbare ' +
      'bedieningslagen over getekende vormen ("onzichtbare laag": dit zijn de echte klikdoelen, gebruik act op die ref). ' +
      'hidden=true toont daarnaast elementen zonder afmeting of met display/visibility verborgen.',
    schema: z.object({
      frame: z.number().int().optional().describe('alleen dit frame (nummer uit fN)'),
      max: z.number().int().optional().describe('maximum aantal elementen, standaard 150'),
      hidden: z.boolean().optional(),
    }),
    run: async (session, a) => text(formatSnapshot(await snapshot(session, a))),
  },
  {
    name: 'act',
    description:
      'Bedien een element met echte (vertrouwde) muis- of toetsenbordinvoer en krijg terug wat er veranderde. ' +
      'Acties: click, dblclick, hover, fill (value), type (value), press (value=toets), select (value), check, uncheck, focus.',
    schema: z.object({
      ref: z.string().describe('ref uit snapshot, bv. f1:e3'),
      action: z.enum(['click', 'dblclick', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'focus']).optional(),
      value: z.string().optional(),
    }),
    run: async (session, a) => text(formatOutcome(await act(session, a))),
  },
  {
    name: 'click_xy',
    description:
      'Echte muisklik op viewport-coördinaten (canvas en vectorvormen). Coördinaten zoals in snapshot. Een punt onder de vouw wordt eerst in beeld gescrold.',
    schema: z.object({ x: z.number(), y: z.number(), double: z.boolean().optional() }),
    run: async (session, a) => text(formatOutcome(await clickXY(session, a))),
  },
  {
    name: 'press',
    description: 'Stuur een echte toets naar het element dat focus heeft (bv. Tab, Enter, Space, ArrowRight, Escape).',
    schema: z.object({ key: z.string() }),
    run: async (session, a) => text(formatOutcome(await press(session, a))),
  },
  {
    name: 'screenshot',
    description: 'JPEG van alleen een frame (frame=N) of element (ref), of anders de viewport. Snel en met harde timeout.',
    schema: z.object({
      frame: z.number().int().optional(),
      ref: z.string().optional(),
      quality: z.number().int().min(10).max(100).optional(),
    }),
    async run(session, a) {
      const { data, clip } = await screenshot(session, a);
      return [
        { type: 'image', data, mimeType: 'image/jpeg' },
        { type: 'text', text: `Uitsnede @${Math.round(clip.x)},${Math.round(clip.y)} ${Math.round(clip.width)}x${Math.round(clip.height)}` },
      ];
    },
  },
  {
    name: 'verify',
    description:
      'Controleer of een beoogde uitkomst bereikt is; wacht tot timeoutMs (standaard 4000). ' +
      'Combineer: text (zichtbaar in een frame), textGone, ref+refHas/refLacks (bv. "checked", "selected", "active-class", "value=\\"x\\""), url, noPause.',
    schema: z.object({
      text: z.string().optional(),
      textGone: z.string().optional(),
      ref: z.string().optional(),
      refHas: z.string().optional(),
      refLacks: z.string().optional(),
      url: z.string().optional(),
      noPause: z.boolean().optional().describe('geen blur/hidden/pagehide/freeze sinds de start of laatste reset'),
      timeoutMs: z.number().int().optional(),
    }),
    run: async (session, { timeoutMs, ...expect }) => text(formatVerify(await verify(session, expect, timeoutMs))),
  },
  {
    name: 'app_events',
    description:
      'Focus-, zichtbaarheids- en fullscreen-events van alle frames sinds de start (of de laatste reset). reset=true begint opnieuw.',
    schema: z.object({ reset: z.boolean().optional() }),
    async run(session, { reset }) {
      const evs = await pauseEventsSince(session, session.markAt);
      const lines = evs.map((e) => `${new Date(e.t).toISOString().slice(11, 23)} ${e.frame} ${e.type}`);
      if (reset) session.markAt = Date.now();
      return text((lines.length ? lines.join('\n') : 'Geen events.') + (reset ? '\n(teller gereset)' : ''));
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Validate the arguments and run one tool. Errors come back as a text result with isError,
// so an agent can read them and try something else.
// extraTools: tools that only one host has (e.g. the buddy's "look"); they win over shared
// tools with the same name. A tool with needsBrowser: false runs without a CDP connection.
// ctx is passed as the third argument to tool.run.
export async function runTool(session, name, args, { extraTools = [], ctx } = {}) {
  const tool = extraTools.find((t) => t.name === name) || TOOL_BY_NAME.get(name);
  if (!tool) return { isError: true, content: text(`Fout: onbekende tool "${name}".`) };
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`).join('; ');
    return { isError: true, content: text(`Fout: ongeldige argumenten voor ${name}: ${why}`) };
  }
  try {
    if (tool.needsBrowser !== false) await session.connect();
    return { isError: false, content: await tool.run(session, parsed.data, ctx) };
  } catch (e) {
    return { isError: true, content: text(`Fout: ${String(e.message || e).split('\n')[0]}`) };
  }
}

// JSON Schema per tool, for model providers that take plain JSON Schema.
export function toolJsonSchemas(extraTools = []) {
  const names = new Set(extraTools.map((t) => t.name));
  return [...TOOLS.filter((t) => !names.has(t.name)), ...extraTools].map((t) => {
    const { $schema, ...parameters } = z.toJSONSchema(t.schema);
    return { name: t.name, description: t.description, parameters };
  });
}
