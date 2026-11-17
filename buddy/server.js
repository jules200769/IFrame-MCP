// Buddy backend: chat API (POST + Server-Sent Events) and the static UI, on 127.0.0.1 only.
// It connects to Chrome at startup and keeps that CDP connection open, so focus emulation is
// active before the user ever clicks into the buddy window.
//
// Two ways to think:
// - a model provider (openai / anthropic / script) runs the agent loop here (buddy/agent.js);
// - the "bridge": no model here. The user's own AI app (Claude Code, Codex, Cursor, ... on their
//   own subscription) is the agent and uses /api/bridge/* through buddy/bridge-mcp.js.
// Both send every tool call through the same CallRunner, so the mode (kijken / vragen / zelf)
// and the approvals apply to both.
//
// Usage: node buddy/server.js   (env: BUDDY_PORT, CDP_URL, BUDDY_PROVIDER, BUDDY_BROWSER, ...)
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Session } from '../src/browser.js';
import { pauseEventsSince, isPause } from '../src/verify.js';
import { BuddyAgent } from './agent.js';
import { CallRunner, MODES, STOPPED } from './policy.js';
import { BUDDY_TOOLS } from './tools.js';
import { createProvider, loadConfig, configPath, PRESETS } from './providers/index.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { bridgeInfoFile, writeBridgeInfo, removeBridgeInfo } from './bridge-info.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_HISTORY = 400;
const BRIDGE_WAIT_MAX_MS = 600000;
const BRIDGE_SEEN_MS = 75000; // a bridge that polled this recently counts as connected

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function safeConfig() {
  try {
    return { cfg: loadConfig() };
  } catch (e) {
    return { cfg: { provider: '', browser: 'dedicated' }, error: e.message };
  }
}

export async function startBuddyServer({
  port = Number(process.env.BUDDY_PORT || 5199),
  host = '127.0.0.1',
  cdpUrl = process.env.CDP_URL || 'http://127.0.0.1:9222',
  provider,
  browser,
  mode,
  capture, // (opts) => Promise<{ data, title, width, height }>; only inside Electron
  reconnectMs = 2000,
  bridgeInfo = bridgeInfoFile(), // false: do not write the token file
  configFile = configPath(), // where "Onthouden" in the model menu saves the choice
} = {}) {
  const { cfg, error: cfgError } = safeConfig();
  browser = (browser || cfg.browser || 'dedicated').toLowerCase();
  const session = new Session({ cdpUrl, browser });
  let providerError = cfgError ?? null;
  if (!provider && !cfgError) {
    const made = createProvider(cfg);
    provider = made.provider;
    providerError = made.error ?? null;
  }
  mode = mode || cfg.mode || (browser === 'user' ? 'vragen' : 'zelf');
  if (!MODES.includes(mode)) throw new Error(`Onbekende BUDDY_MODE "${mode}". Kies ${MODES.join(', ')}.`);

  const clients = new Set();
  const history = []; // events of the current conversation, replayed to a (re)connecting UI
  const broadcast = (ev) => {
    const e = { t: Date.now(), ...ev };
    if (e.type !== 'status') {
      history.push(e);
      if (history.length > MAX_HISTORY) history.shift();
    }
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of clients) res.write(line);
  };

  const runner = new CallRunner({ session, emit: broadcast, extraTools: BUDDY_TOOLS, ctx: { capture }, mode });
  // The model can be switched at runtime from the buddy's model menu (POST /api/provider).
  let isBridge = false;
  let agent = null;
  // What the menu shows as current choice; the API key itself never leaves the server.
  let current = provider && !cfg.provider
    ? { provider: provider.name, model: provider.model }
    : { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, vision: cfg.vision, apiKey: cfg.apiKey };
  const useProvider = (p) => {
    agent?.stop();
    provider = p;
    isBridge = !!p?.bridge;
    agent = p && !isBridge ? new BuddyAgent({ provider: p, emit: broadcast, runner }) : null;
  };
  useProvider(provider);

  // --- Bridge state: messages wait here until the user's AI app fetches them. ---
  const bridge = {
    token: randomBytes(32).toString('hex'),
    queue: [],
    waiters: new Set(),
    busy: false,
    stopNotice: false,
    ac: null,
    lastPoll: 0,
    nextCall: 1,
  };
  const wakeBridge = () => {
    for (const w of bridge.waiters) w();
  };

  // --- Chrome connection ---
  // dedicated: keep it up at all times (retry every reconnectMs).
  // user: Chrome asks for permission on every connection, so connect once at startup and
  // afterwards only when the user clicks "Koppel".
  let chromeError = null;
  let connecting = null;
  const ensureConnected = ({ explicit = false } = {}) => {
    if (session.connected || connecting) return connecting;
    connecting = session
      .connect({ explicit })
      .then(() => {
        chromeError = null;
      })
      .catch((e) => {
        chromeError = e.message.split('\n')[0];
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  };
  if (browser === 'user') ensureConnected(); // may wait for the Allow click; do not block startup
  else await ensureConnected();
  const timer = setInterval(() => {
    if (browser === 'dedicated') ensureConnected();
  }, reconnectMs);
  timer.unref();

  async function status() {
    const connected = session.connected;
    const out = {
      browser,
      chrome: connected,
      connecting: !!connecting,
      chromeError: connected ? null : chromeError,
      provider: provider ? `${provider.name}${provider.model && provider.model !== provider.name ? ` · ${provider.model}` : ''}` : null,
      providerError,
      mode: runner.mode,
      approvals: runner.waiting,
      capture: !!capture,
      busy: isBridge ? bridge.busy : !!agent?.busy,
      bridge: isBridge ? { connected: bridge.waiters.size > 0 || Date.now() - bridge.lastPoll < BRIDGE_SEEN_MS, queued: bridge.queue.length } : null,
      fullscreen: false,
      pauses: 0,
      tab: null,
    };
    if (!connected || !session.page || session.page.isClosed()) return out;
    try {
      out.tab = { title: await session.page.title(), url: session.page.url() };
      for (const { frame } of await session.frames()) {
        const s = await session.call(frame, 'status').catch(() => null);
        if (s?.fullscreen) out.fullscreen = true;
      }
      out.pauses = (await pauseEventsSince(session, session.markAt)).filter(isPause).length;
    } catch {
      // Page navigating; report what we have.
    }
    return out;
  }

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new HttpError(400, 'ongeldige JSON'));
        }
      });
      req.on('error', reject);
    });

  // The buddy can drive the user's logged-in Chrome, so a web page in that same Chrome must
  // not be able to drive the buddy: only our own host names (no DNS rebinding), no
  // cross-site POSTs (a JSON content type forces a CORS preflight we never answer), and the
  // bridge needs the token from the info file.
  let actualPort = port;
  const ownHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  const ownOrigins = () => new Set([...ownHosts()].map((h) => `http://${h}`));
  function guard(req, url) {
    if (!ownHosts().has(req.headers.host)) throw new HttpError(403, 'onbekende host');
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !ownOrigins().has(origin)) throw new HttpError(403, 'verzoek van een andere site geweigerd');
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'gebruik content-type: application/json');
    }
    if (url.pathname.startsWith('/api/bridge/')) {
      const given = Buffer.from(String(req.headers['x-buddy-token'] || ''));
      const want = Buffer.from(bridge.token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, 'ongeldig of ontbrekend bridge-token');
      if (!isBridge) throw new HttpError(409, 'de buddy draait niet als bridge (BUDDY_PROVIDER=bridge)');
    }
  }

  function stopAll() {
    agent?.stop();
    runner.denyAll();
    if (isBridge && bridge.busy) {
      bridge.ac?.abort();
      bridge.busy = false;
      bridge.queue.length = 0;
      bridge.stopNotice = true;
      wakeBridge();
      broadcast({ type: 'done', outcome: 'stopped' });
    }
  }

  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', history })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await status());

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      if (!agent && !isBridge) return json(res, 503, { error: providerError || 'Geen model ingesteld.' });
      const { text } = await readBody(req);
      if (!text || typeof text !== 'string') return json(res, 400, { error: 'text ontbreekt' });
      if (isBridge) {
        if (bridge.busy) return json(res, 409, { error: 'Je AI-app is nog bezig met het vorige bericht.' });
        bridge.busy = true;
        bridge.stopNotice = false;
        bridge.ac = new AbortController();
        broadcast({ type: 'user', text });
        bridge.queue.push(text);
        wakeBridge();
        const seen = bridge.waiters.size > 0 || Date.now() - bridge.lastPoll < BRIDGE_SEEN_MS;
        if (!seen) broadcast({ type: 'note', text: 'Nog geen AI-app gekoppeld: start in Claude Code, Codex of Cursor de prompt "buddy" van de MCP-server iframe-buddy (zie README).' });
        return json(res, 202, { ok: true });
      }
      if (agent.busy) return json(res, 409, { error: 'De buddy is nog bezig.' });
      if (browser === 'dedicated') await ensureConnected();
      broadcast({ type: 'user', text });
      agent.send(text).catch(() => {}); // outcome arrives as events
      return json(res, 202, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      stopAll();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      stopAll();
      agent?.reset();
      bridge.queue.length = 0;
      bridge.stopNotice = false;
      history.length = 0;
      broadcast({ type: 'reset' });
      history.length = 0;
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/mode') {
      const { mode: m } = await readBody(req);
      if (!MODES.includes(m)) return json(res, 400, { error: `modus moet ${MODES.join(', ')} zijn` });
      runner.setMode(m);
      broadcast({ type: 'mode', mode: m });
      return json(res, 200, { ok: true, mode: m });
    }
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      const { id, allow } = await readBody(req);
      if (!runner.answer(String(id), !!allow)) return json(res, 404, { error: 'deze vraag staat niet (meer) open' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/providers') {
      const { apiKey, ...shown } = current;
      return json(res, 200, { presets: PRESETS, current: { ...shown, hasKey: !!apiKey }, active: provider?.name ?? null, error: providerError });
    }
    if (req.method === 'POST' && url.pathname === '/api/provider') {
      if (isBridge ? bridge.busy : agent?.busy) return json(res, 409, { error: 'De buddy is nog bezig; druk eerst op Stop.' });
      const body = await readBody(req);
      const name = String(body.provider || '').toLowerCase();
      const envKey = name === 'anthropic' ? process.env.ANTHROPIC_API_KEY : name === 'openai' ? process.env.OPENAI_API_KEY : undefined;
      const next = {
        provider: name,
        model: body.model?.trim() || undefined,
        baseUrl: body.baseUrl?.trim() || undefined,
        // Empty key field: keep the key we had for this provider, else the environment's.
        apiKey: body.apiKey || (current.provider === name ? current.apiKey : undefined) || process.env.BUDDY_API_KEY || envKey,
        vision: body.vision !== false,
        effort: cfg.effort || 'medium',
      };
      if (name === 'anthropic' && !next.model) next.model = PRESETS.find((p) => p.id === 'anthropic').model;
      const made = createProvider(next);
      if (made.error) return json(res, 400, { error: made.error });
      stopAll();
      agent?.reset();
      useProvider(made.provider);
      providerError = null;
      current = next;
      history.length = 0;
      broadcast({ type: 'reset' });
      history.length = 0;
      let saved = false;
      if (body.save && configFile) {
        let file = {};
        try {
          if (existsSync(configFile)) file = JSON.parse(readFileSync(configFile, 'utf8'));
        } catch {
          file = {};
        }
        for (const k of ['provider', 'model', 'baseUrl', 'apiKey', 'vision']) delete file[k];
        const keep = { provider: next.provider, model: next.model, baseUrl: next.baseUrl, vision: next.vision === false ? false : undefined };
        if (body.apiKey) keep.apiKey = body.apiKey; // only a key typed in the menu; env keys stay in env
        writeFileSync(configFile, JSON.stringify({ ...file, ...JSON.parse(JSON.stringify(keep)) }, null, 2) + '\n');
        saved = true;
      }
      const label = `${made.provider.name}${made.provider.model && made.provider.model !== made.provider.name ? ` · ${made.provider.model}` : ''}`;
      broadcast({ type: 'note', text: `Model: ${label}${saved ? ' (onthouden)' : ''}. Nieuw gesprek gestart.` });
      return json(res, 200, { ok: true, provider: label, saved });
    }
    if (req.method === 'POST' && url.pathname === '/api/connect') {
      // Explicit: in "user" mode this is what opens Chrome's permission dialog again.
      await ensureConnected({ explicit: true });
      return json(res, session.connected ? 200 : 502, { ok: session.connected, error: session.connected ? undefined : chromeError });
    }

    // --- Bridge (token checked in guard) ---
    if (req.method === 'GET' && url.pathname === '/api/bridge/next') {
      const timeoutMs = Math.max(0, Math.min(Number(url.searchParams.get('timeoutMs')) || 50000, BRIDGE_WAIT_MAX_MS));
      bridge.lastPoll = Date.now();
      const take = () => {
        if (bridge.stopNotice) {
          bridge.stopNotice = false;
          return { stopped: true };
        }
        if (bridge.queue.length) return { message: bridge.queue.shift() };
        return null;
      };
      let out = take();
      if (!out && timeoutMs > 0) {
        out = await new Promise((resolve) => {
          const done = (v) => {
            clearTimeout(t);
            bridge.waiters.delete(wake);
            req.off('close', onClose);
            resolve(v);
          };
          const wake = () => {
            const v = take();
            if (v) done(v);
          };
          const onClose = () => done(null);
          const t = setTimeout(() => done({ none: true }), timeoutMs);
          bridge.waiters.add(wake);
          req.on('close', onClose);
        });
        if (!out) return; // client went away
      }
      bridge.lastPoll = Date.now();
      return json(res, 200, out || { none: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/bridge/reply') {
      const { text, done } = await readBody(req);
      if (text && typeof text === 'string') broadcast({ type: 'assistant', text });
      if (done && bridge.busy) {
        bridge.busy = false;
        bridge.ac = null;
        broadcast({ type: 'done', outcome: 'done' });
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/bridge/tool') {
      const { name, args } = await readBody(req);
      if (!name || typeof name !== 'string') return json(res, 400, { error: 'name ontbreekt' });
      const signal = bridge.ac?.signal;
      const result = signal?.aborted
        ? { isError: true, content: [{ type: 'text', text: STOPPED }] }
        : await runner.runCall({ id: `b${bridge.nextCall++}`, name, args: args ?? {} }, { signal });
      return json(res, 200, result);
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const file = path.join(UI_DIR, path.normalize(rel));
      if (!file.startsWith(UI_DIR)) return json(res, 403, { error: 'verboden' });
      const body = await readFile(file).catch(() => null);
      if (!body) return json(res, 404, { error: 'niet gevonden' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(body);
    }
    json(res, 404, { error: 'niet gevonden' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://buddy.local');
      guard(req, url);
      await handle(req, res, url);
    } catch (e) {
      if (!res.headersSent) json(res, e instanceof HttpError ? e.code : 500, { error: e.message });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  actualPort = server.address().port;
  if (bridgeInfo) writeBridgeInfo(bridgeInfo, { port: actualPort, token: bridge.token, pid: process.pid });

  return {
    url: `http://${host}:${actualPort}/`,
    port: actualPort,
    token: bridge.token,
    session,
    agent,
    runner,
    status,
    connect: () => ensureConnected({ explicit: true }),
    async close() {
      clearInterval(timer);
      stopAll();
      for (const w of bridge.waiters) w();
      for (const res of clients) res.end();
      clients.clear();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      if (bridgeInfo) removeBridgeInfo(bridgeInfo, bridge.token);
      await session.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srv = await startBuddyServer();
  const st = await srv.status();
  console.log(`Buddy op ${srv.url}`);
  if (st.browser === 'user') console.log('Je gewone Chrome: klik in Chrome op "Toestaan" als dat gevraagd wordt.');
  else console.log(st.chrome ? 'Gekoppeld aan Chrome.' : `Nog geen Chrome: ${st.chromeError} (blijft opnieuw proberen).`);
  if (st.providerError) console.log(`Let op: ${st.providerError}`);
  else console.log(`Model: ${st.provider}${st.provider === 'bridge' ? ' (je AI-app is de agent; zie README › Met je abonnement)' : ''}`);
  console.log(`Modus: ${st.mode}`);
}
