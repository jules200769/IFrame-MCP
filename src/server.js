// MCP server: lets an agent (e.g. Claude Code) see, drive and verify iframe apps in Chrome.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Session } from './browser.js';
import { listFrames, snapshot, formatFrames, formatSnapshot } from './snapshot.js';
import { act, clickXY, press, screenshot, formatOutcome } from './actions.js';
import { verify, formatVerify, pauseEventsSince } from './verify.js';

const session = new Session({ cdpUrl: process.env.CDP_URL || 'http://127.0.0.1:9222' });
const server = new McpServer({ name: 'iframe-agent', version: '0.1.0' });

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const tool = (name, description, inputSchema, handler) =>
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      await session.connect();
      return await handler(args ?? {});
    } catch (e) {
      return { ...text(`Fout: ${e.message.split('\n')[0]}`), isError: true };
    }
  });

tool(
  'tabs',
  'Lijst de open tabs. select=<index> kiest de tab waarin de agent werkt; front=true zet die tab vooraan ' +
    '(nodig voor renderen/screenshots); close=<index> sluit een tab (bv. een tab die een actie opende).',
  { select: z.number().int().optional(), front: z.boolean().optional(), close: z.number().int().optional() },
  async ({ select, front, close }) => {
    let pages = session.context.pages();
    if (close !== undefined) {
      if (!pages[close]) throw new Error(`Geen tab ${close}.`);
      if (pages[close] === session.page) throw new Error('Dat is de tab waarin de agent werkt; kies eerst een andere.');
      await pages[close].close();
      pages = session.context.pages();
    }
    if (select !== undefined) {
      if (!pages[select]) throw new Error(`Geen tab ${select}.`);
      session.page = pages[select];
    }
    if (front || close !== undefined) await (await session.currentPage()).bringToFront();
    const cur = await session.currentPage();
    const rows = await Promise.all(
      pages.map(async (p, i) => `${p === cur ? '*' : ' '} ${i}: ${await p.title().catch(() => '')} — ${p.url()}`),
    );
    return text(rows.join('\n'));
  },
);

tool(
  'open',
  'Open een URL in de huidige tab (of newTab=true voor een nieuwe tab).',
  { url: z.string(), newTab: z.boolean().optional() },
  async ({ url, newTab }) => {
    if (newTab) {
      session.page = await session.context.newPage();
      await session.preparePage(session.page).catch(() => {});
    }
    const page = await session.currentPage();
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    return text(`Geopend: ${await page.title()} — ${page.url()}`);
  },
);

tool(
  'frames',
  'Lijst alle frames van de tab (ook cross-origin iframes) met positie, focus en zichtbaarheid.',
  {},
  async () => text(formatFrames(await listFrames(session))),
);

tool(
  'snapshot',
  'Toon bedienbare elementen in ALLE frames, met refs als f1:e3 en een korte tekst per frame. ' +
    'Bevat ook niet-semantische klikdoelen van eigen players (role "clickable") en onzichtbare ' +
    'bedieningslagen over getekende vormen ("onzichtbare laag": dit zijn de echte klikdoelen, gebruik act op die ref). ' +
    'hidden=true toont daarnaast elementen zonder afmeting of met display/visibility verborgen.',
  {
    frame: z.number().int().optional().describe('alleen dit frame (nummer uit fN)'),
    max: z.number().int().optional().describe('maximum aantal elementen, standaard 150'),
    hidden: z.boolean().optional(),
  },
  async (a) => text(formatSnapshot(await snapshot(session, a))),
);

tool(
  'act',
  'Bedien een element met echte (vertrouwde) muis- of toetsenbordinvoer en krijg terug wat er veranderde. ' +
    'Acties: click, dblclick, hover, fill (value), type (value), press (value=toets), select (value), check, uncheck, focus.',
  {
    ref: z.string().describe('ref uit snapshot, bv. f1:e3'),
    action: z.enum(['click', 'dblclick', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'focus']).optional(),
    value: z.string().optional(),
  },
  async (a) => text(formatOutcome(await act(session, a))),
);

tool(
  'click_xy',
  'Echte muisklik op viewport-coördinaten (terugval voor canvas/vectorvormen zonder ref). Coördinaten zoals in snapshot.',
  { x: z.number(), y: z.number(), double: z.boolean().optional() },
  async (a) => text(formatOutcome(await clickXY(session, a))),
);

tool(
  'press',
  'Stuur een echte toets naar het element dat focus heeft (bv. Tab, Enter, Space, ArrowRight, Escape).',
  { key: z.string() },
  async (a) => text(formatOutcome(await press(session, a))),
);

tool(
  'screenshot',
  'JPEG van alleen een frame (frame=N) of element (ref), of anders de viewport. Snel en met harde timeout.',
  { frame: z.number().int().optional(), ref: z.string().optional(), quality: z.number().int().min(10).max(100).optional() },
  async (a) => {
    const { data, clip } = await screenshot(session, a);
    return {
      content: [
        { type: 'image', data, mimeType: 'image/jpeg' },
        { type: 'text', text: `Uitsnede @${Math.round(clip.x)},${Math.round(clip.y)} ${Math.round(clip.width)}x${Math.round(clip.height)}` },
      ],
    };
  },
);

tool(
  'verify',
  'Controleer of een beoogde uitkomst bereikt is; wacht tot timeoutMs (standaard 4000). ' +
    'Combineer: text (zichtbaar in een frame), textGone, ref+refHas/refLacks (bv. "checked", "selected", "active-class", "value=\\"x\\""), url, noPause.',
  {
    text: z.string().optional(),
    textGone: z.string().optional(),
    ref: z.string().optional(),
    refHas: z.string().optional(),
    refLacks: z.string().optional(),
    url: z.string().optional(),
    noPause: z.boolean().optional().describe('geen blur/hidden/pagehide/freeze sinds de start of laatste reset'),
    timeoutMs: z.number().int().optional(),
  },
  async ({ timeoutMs, ...expect }) => text(formatVerify(await verify(session, expect, timeoutMs))),
);

tool(
  'app_events',
  'Focus-, zichtbaarheids- en fullscreen-events van alle frames sinds de start (of de laatste reset). reset=true begint opnieuw.',
  { reset: z.boolean().optional() },
  async ({ reset }) => {
    const evs = await pauseEventsSince(session, session.markAt);
    const lines = evs.map((e) => `${new Date(e.t).toISOString().slice(11, 23)} ${e.frame} ${e.type}`);
    if (reset) session.markAt = Date.now();
    return text((lines.length ? lines.join('\n') : 'Geen events.') + (reset ? '\n(teller gereset)' : ''));
  },
);

await server.connect(new StdioServerTransport());
