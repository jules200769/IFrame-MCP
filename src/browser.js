// Connection to a running Chrome over CDP, with frame bookkeeping and keep-alive settings.
import { chromium } from 'playwright-core';
import { INJECTED_SOURCE, AGENT_VERSION } from './injected.js';
import { readDevToolsActivePort, chromeUserDataDir, ENABLE_HINT } from './endpoint.js';

// Two kinds of browser:
// - "dedicated": the Chrome started by `npm run chrome` (own profile, keep-alive flags).
//   Every tab gets the helper, and the connection is retried automatically.
// - "user": the user's everyday Chrome, reached via chrome://inspect/#remote-debugging.
//   Only the tab the agent works in is touched, and because Chrome asks for permission on
//   every connection, reconnecting is manual unless reconnect: 'auto' is passed.
export class Session {
  constructor({ cdpUrl = 'http://127.0.0.1:9222', browser = 'dedicated', userDataDir, reconnect } = {}) {
    if (!['dedicated', 'user'].includes(browser)) throw new Error(`Onbekende browser "${browser}". Kies dedicated of user.`);
    this.cdpUrl = cdpUrl;
    this.kind = browser;
    this.userDataDir = userDataDir;
    this.reconnect = reconnect || (browser === 'user' ? 'manual' : 'auto');
    this.attempted = false;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.frameIds = new WeakMap(); // Frame -> stable number (f0, f1, ...)
    this.frameById = new Map(); // number -> Frame
    this.nextFrame = 0;
    this.prepared = new WeakSet(); // Pages/Frames with keep-alive applied
    this.markAt = Date.now(); // start of the window that verify({noPause}) looks at
    this.lastActionAt = Date.now();
  }

  get connected() {
    return !!this.browser?.isConnected();
  }

  // explicit: the user asked to connect (e.g. the Koppel button). In "user" mode without
  // auto-reconnect, only the first attempt and explicit ones open Chrome's permission dialog.
  async connect({ explicit = false } = {}) {
    if (this.connected) return;
    if (this.kind === 'user' && this.reconnect === 'manual' && this.attempted && !explicit) {
      throw new Error('Je Chrome is niet gekoppeld. Klik in de buddy op "Koppel"; Chrome vraagt dan om toestemming.');
    }
    this.attempted = true;
    let endpoint = this.cdpUrl;
    if (this.kind === 'user') endpoint = readDevToolsActivePort(this.userDataDir || chromeUserDataDir()).wsEndpoint;
    try {
      // In "user" mode the handshake waits until the user clicks Allow in Chrome.
      this.browser = await chromium.connectOverCDP(endpoint, { timeout: this.kind === 'user' ? 60000 : 5000 });
    } catch (e) {
      const why = e.message.split('\n')[0];
      throw new Error(
        this.kind === 'user'
          ? `Koppelen aan je Chrome lukte niet (geweigerd, verlopen of Chrome gesloten). ${ENABLE_HINT} (${why})`
          : `Geen Chrome op ${this.cdpUrl}. Start eerst: npm run chrome. (${why})`,
      );
    }
    this.context = this.browser.contexts()[0];
    this.frameById.clear();
    if (this.kind === 'dedicated') {
      await this.context.addInitScript({ content: INJECTED_SOURCE });
      for (const p of this.context.pages()) await this.preparePage(p);
      this.context.on('page', (p) => this.preparePage(p).catch(() => {}));
    }
    await this.selectPage(await this.pickDefaultPage());
  }

  async pickDefaultPage() {
    const pages = this.context.pages();
    const web = pages.filter((p) => /^https?:|^file:/.test(p.url()));
    if (this.kind === 'user') {
      // The tab in front (visible) is the one the user is looking at.
      for (const p of web) {
        if ((await p.evaluate(() => document.visibilityState).catch(() => '')) === 'visible') return p;
      }
    }
    return web[0] || pages[0] || null;
  }

  // Make `page` the tab the agent works in. In "user" mode this is the only tab that gets
  // the helper and keep-alive emulation.
  async selectPage(page) {
    this.page = page;
    if (!page || this.kind !== 'user' || this.prepared.has(page)) return page;
    await page.addInitScript({ content: INJECTED_SOURCE }).catch(() => {});
    await this.preparePage(page);
    return page;
  }

  async currentPage() {
    await this.connect();
    if (!this.page || this.page.isClosed()) await this.selectPage((await this.pickDefaultPage()) || (await this.context.newPage()));
    return this.page;
  }

  // Make the page believe it keeps focus and stays active, even when the Chrome window
  // is behind another window. Applied to the page and to every out-of-process iframe.
  async keepAlive(target) {
    if (this.prepared.has(target)) return;
    this.prepared.add(target);
    let cdp;
    try {
      cdp = await this.context.newCDPSession(target);
    } catch {
      return; // In-process frame: covered by the page's session.
    }
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    if (target === this.page || typeof target.mainFrame === 'function') target.__agentCdp = cdp;
  }

  async preparePage(page) {
    await this.keepAlive(page);
    const prepareFrame = async (f) => {
      if (f !== page.mainFrame()) await this.keepAlive(f);
      await f.evaluate(INJECTED_SOURCE).catch(() => {});
    };
    page.on('frameattached', (f) => prepareFrame(f).catch(() => {}));
    page.on('framenavigated', (f) => prepareFrame(f).catch(() => {}));
    await Promise.all(page.frames().map((f) => prepareFrame(f).catch(() => {})));
  }

  frameId(frame) {
    let id = this.frameIds.get(frame);
    if (id === undefined) {
      id = this.nextFrame++;
      this.frameIds.set(frame, id);
    }
    this.frameById.set(id, frame);
    return id;
  }

  async frames() {
    const page = await this.currentPage();
    const out = [];
    const visit = (frame, depth) => {
      if (frame.isDetached()) return;
      out.push({ frame, depth });
      for (const c of frame.childFrames()) visit(c, depth + 1);
    };
    visit(page.mainFrame(), 0);
    this.frameId(page.mainFrame()); // main frame claims f0 first
    for (const f of out) f.id = this.frameId(f.frame);
    return out;
  }

  getFrame(id) {
    const f = this.frameById.get(id);
    if (!f || f.isDetached()) throw new Error(`Frame f${id} bestaat niet meer. Maak een nieuwe snapshot.`);
    return f;
  }

  // Call a helper method inside a frame; injects the helper first if the frame lacks it
  // (e.g. a document that loaded before we connected).
  async call(frame, method, arg) {
    const run = () =>
      frame.evaluate(
        ([m, a, ver]) =>
          window.__iframeAgent && window.__iframeAgent.version === ver && window.__iframeAgent.alive()
            ? { ok: true, v: window.__iframeAgent[m](a) }
            : { ok: false },
        [method, arg, AGENT_VERSION],
      );
    let res = await run();
    if (!res.ok) {
      await frame.evaluate(INJECTED_SOURCE);
      res = await run();
    }
    return res.v;
  }

  async elementFor(frame, id) {
    if (!(await this.call(frame, 'has', id))) return null;
    const handle = await frame.evaluateHandle((i) => window.__iframeAgent.get(i), id);
    const el = handle.asElement();
    if (!el) {
      await handle.dispose();
      return null;
    }
    return el;
  }

  // Viewport position of the frame's content (0,0 for the main frame).
  async frameBox(frame) {
    if (!frame.parentFrame()) return { x: 0, y: 0, width: null, height: null };
    const el = await frame.frameElement().catch(() => null);
    const box = el && (await el.boundingBox().catch(() => null));
    await el?.dispose();
    return box || null;
  }

  // Buttons inside a closed shadow root are invisible to page script. CDP still
  // sees them; resolve each node and let the helper adopt the real element.
  async closedShadowItems(frame, { hidden = false } = {}) {
    let cdp;
    let detach = false;
    try {
      cdp = await this.context.newCDPSession(frame);
      detach = true;
    } catch {
      if (frame.parentFrame()) return [];
      cdp = await this.cdp();
    }
    try {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const ids = [];
      const walk = (node, closed) => {
        for (const sr of node.shadowRoots || []) walk(sr, closed || sr.shadowRootType === 'closed');
        if (closed && node.nodeType === 1 && node.backendNodeId) ids.push(node.backendNodeId);
        if (node.nodeName === 'IFRAME' || node.nodeName === 'FRAME') return;
        for (const c of node.children || []) walk(c, closed);
      };
      walk(root, false);
      const items = [];
      for (const backendNodeId of ids.slice(0, 40)) {
        const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
        if (!object?.objectId) continue;
        const described = await cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function (hidden) {
            const a = window.__iframeAgent;
            return a && a.describeElement ? a.describeElement(this, hidden) : null;
          }`,
          arguments: [{ value: !!hidden }],
          returnByValue: true,
        }).catch(() => null);
        await cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
        const item = described?.result?.value;
        if (item) items.push({ ...item, closedShadow: true });
      }
      return items;
    } catch {
      return [];
    } finally {
      if (detach) await cdp.detach().catch(() => {});
    }
  }

  async cdp() {
    const page = await this.currentPage();
    if (!page.__agentCdp) {
      this.prepared.delete(page);
      await this.keepAlive(page);
    }
    return page.__agentCdp;
  }

  async close() {
    // Only drop the connection; the user's Chrome keeps running.
    await this.browser?.close().catch(() => {});
  }
}
