// Bridge MCP server "iframe-buddy": lets the user's own AI app (Claude Code, Codex CLI, Cursor,
// Copilot, Gemini CLI, ... running on the user's own subscription) be the buddy's brain.
// The app calls buddy_wait to receive what the user typed in the buddy window, drives the
// browser with the usual tools (forwarded to the running buddy, so the buddy's mode,
// approvals, step list and single CDP connection apply) and answers with buddy_reply.
// No model, API key or subscription token passes through this code.
// Started by the AI app over stdio; needs a running buddy with BUDDY_PROVIDER=bridge.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { TOOLS } from '../src/tools.js';
import { BUDDY_TOOLS } from './tools.js';
import { RULES, WORKFLOW } from './prompt.js';
import { bridgeInfoFile, readBridgeInfo } from './bridge-info.js';

const DEFAULT_WAIT_S = 50; // below Codex' default MCP tool timeout of 60 s
const MAX_WAIT_S = 600;

export const LOOP = `Je bent de browserbuddy van de gebruiker. De gebruiker typt opdrachten in het buddy-venster boven Chrome; jij voert ze uit.
Lus: roep buddy_wait aan → voer het bericht uit met de browsertools van deze server (iframe-buddy) → antwoord met buddy_reply (done=true als je klaar bent) → roep meteen weer buddy_wait aan.
Gebruik de browsertools van iframe-buddy (niet die van iframe-agent): dan ziet de gebruiker elke stap in de buddy en gelden de modus en goedkeuringen van de buddy.
Geeft buddy_wait "Nog geen bericht", roep hem dan opnieuw aan. Stop de lus alleen als de gebruiker dat hier in deze chat vraagt.
Antwoord in buddy_reply kort en in de taal van de gebruiker.`;

export const INSTRUCTIONS = `${LOOP}\n\n${WORKFLOW}\n\n${RULES}`;

const text = (t) => [{ type: 'text', text: t }];

export function createBridgeClient({ infoFile = bridgeInfoFile(), fetchImpl = fetch } = {}) {
  async function call(method, pathname, body, { timeoutMs = 120000 } = {}) {
    const info = readBridgeInfo(infoFile);
    if (!info?.port || !info?.token) {
      throw new Error('De buddy draait niet. Start hem met BUDDY_PROVIDER=bridge npm run buddy (zie README › Met je abonnement).');
    }
    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${info.port}${pathname}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-buddy-token': info.token },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`De buddy op poort ${info.port} reageert niet (${e.cause?.code || e.name}). Start hem met BUDDY_PROVIDER=bridge npm run buddy.`);
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `buddy gaf HTTP ${res.status}`);
    return out;
  }
  return {
    next: (timeoutSec) => call('GET', `/api/bridge/next?timeoutMs=${timeoutSec * 1000}`, undefined, { timeoutMs: timeoutSec * 1000 + 15000 }),
    reply: (t, done) => call('POST', '/api/bridge/reply', { text: t, done }),
    tool: (name, args) => call('POST', '/api/bridge/tool', { name, args }, { timeoutMs: 15 * 60 * 1000 }), // may wait for an approval
  };
}

export function createBridgeServer(opts = {}) {
  const client = createBridgeClient(opts);
  const server = new McpServer({ name: 'iframe-buddy', version: '0.2.0' }, { instructions: INSTRUCTIONS });
  const fail = (e) => ({ isError: true, content: text(`Fout: ${String(e.message || e).split('\n')[0]}`) });

  server.registerTool(
    'buddy_wait',
    {
      description:
        'Wacht op het volgende bericht dat de gebruiker in het buddy-venster typt (long-poll). ' +
        `Standaard ${DEFAULT_WAIT_S} s; verhoog timeoutSec alleen als je app een langere MCP-time-out heeft (max ${MAX_WAIT_S}).`,
      inputSchema: { timeoutSec: z.number().int().min(1).max(MAX_WAIT_S).optional() },
    },
    async ({ timeoutSec = DEFAULT_WAIT_S }) => {
      try {
        const out = await client.next(timeoutSec);
        if (out.message) {
          return {
            content: text(
              `Bericht van de gebruiker in de buddy:\n${out.message}\n\n` +
                'Voer dit uit met de browsertools van iframe-buddy, antwoord met buddy_reply (done=true als je klaar bent) en roep daarna weer buddy_wait aan. ' +
                'Kies of verstuur geen toetsantwoorden; doe niets onomkeerbaars zonder een uitdrukkelijk "ja".',
            ),
          };
        }
        if (out.stopped) return { content: text('De gebruiker drukte op Stop in de buddy. Stop met de lopende opdracht en roep buddy_wait aan voor het volgende bericht.') };
        return { content: text('Nog geen bericht. Roep buddy_wait opnieuw aan om te blijven luisteren.') };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'buddy_reply',
    {
      description: 'Toon je antwoord in het buddy-venster. done=true sluit de opdracht af (de gebruiker kan dan een nieuw bericht sturen).',
      inputSchema: { text: z.string(), done: z.boolean().optional() },
    },
    async ({ text: t, done }) => {
      try {
        await client.reply(t, done ?? true);
        return { content: text(done === false ? 'Getoond in de buddy.' : 'Getoond in de buddy. Roep nu buddy_wait aan voor het volgende bericht.') };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // The browser tools, forwarded to the running buddy.
  for (const t of [...TOOLS.filter((x) => !BUDDY_TOOLS.some((b) => b.name === x.name)), ...BUDDY_TOOLS]) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema.shape }, async (args) => {
      try {
        const { content, isError } = await client.tool(t.name, args);
        return isError ? { content, isError: true } : { content };
      } catch (e) {
        return fail(e);
      }
    });
  }

  server.registerPrompt(
    'buddy',
    { description: 'Start de browserbuddy-lus: luister naar de buddy en voer de berichten uit.' },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `${LOOP}\n\nBegin nu met buddy_wait.\n\n${RULES}`,
          },
        },
      ],
    }),
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createBridgeServer().connect(new StdioServerTransport());
}
