// MCP server: lets an agent (e.g. Claude Code) see, drive and verify iframe apps in Chrome.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Session } from './browser.js';
import { TOOLS, runTool } from './tools.js';

// IFRAME_AGENT_BROWSER=user: your everyday Chrome (chrome://inspect/#remote-debugging, Chrome 144+).
// Each (re)connect asks for permission in Chrome; the agent only connects when it calls a tool.
const session = new Session({
  cdpUrl: process.env.CDP_URL || 'http://127.0.0.1:9222',
  browser: process.env.IFRAME_AGENT_BROWSER || 'dedicated',
  reconnect: 'auto',
});
const server = new McpServer({ name: 'iframe-agent', version: '0.1.0' });

for (const t of TOOLS) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.schema.shape }, async (args) => {
    const { content, isError } = await runTool(session, t.name, args);
    return isError ? { content, isError: true } : { content };
  });
}

await server.connect(new StdioServerTransport());
