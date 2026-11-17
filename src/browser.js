// Connection to a running Chrome over CDP, with frame bookkeeping and keep-alive settings.
import { chromium } from 'playwright-core';
import { INJECTED_SOURCE, AGENT_VERSION } from './injected.js';

export class Session {
  constructor({ cdpUrl = 'http://127.0.0.1:9222' } = {}) {
    this.cdpUrl = cdpUrl;
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

  async connect() {
    if (this.browser?.isConnected()) return;
    try {
      this.browser = await chromium.connectOverCDP(this.cdpUrl, { timeout: 5000 });
    } catch (e) {
      throw new Error(`Geen Chrome op ${this.cdpUrl}. Start eerst: npm run chrome. (${e.message.split('\n')[0]})`);
    }
    this.context = this.browser.contexts()[0];
    await this.context.addInitScript({ content: INJECTED_SOURCE });
    for (const p of this.context.pages()) await this.preparePage(p);
    this.context.on('page', (p) => this.preparePage(p).catch(() => {}));
    this.page = this.pickDefaultPage();
  }

  pickDefaultPage() {
    const pages = this.context.pages();
    return pages.find((p) => /^https?:|^file:/.test(p.url())) || pages[0] || null;
  }

  async currentPage() {
    await this.connect();
    if (!this.page || this.page.isClosed()) this.page = this.pickDefaultPage() || (await this.context.newPage());
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
          window.__iframeAgent && window.__iframeAgent.version === ver
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
