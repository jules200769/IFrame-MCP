// Helper that runs inside every frame (main page and each iframe).
// It never changes the app's DOM: refs live in an in-memory Map.
// Exported as source text so it can be used both as an init script and via frame.evaluate().

function install(version) {
  // The helper outlives our server process (it lives in the page), so a page that is still
  // open can hold an older version. Replace it instead of keeping it.
  const old = window.__iframeAgent;
  if (old && old.version === version) return;
  if (old && typeof old.dispose === 'function') old.dispose();

  const A = {
    version,
    refs: new Map(), // id -> Element
    ids: new WeakMap(), // Element -> id
    next: 1,
    mutations: 0,
    events: [],
  };
  const ac = new AbortController();
  const on = (target, type, fn) => target.addEventListener(type, fn, { signal: ac.signal });

  const record = (type, extra = {}) => {
    A.events.push({ type, t: Date.now(), ...extra });
    if (A.events.length > 200) A.events.shift();
  };
  // Window-level blur only (element blur does not bubble to a non-capturing window listener).
  // Focus moving into one of our own iframes also blurs this window; that is not a pause.
  on(window, 'blur', (e) => {
    if (e.target !== window) return;
    setTimeout(() => {
      const ae = document.activeElement;
      record(ae && (ae.tagName === 'IFRAME' || ae.tagName === 'FRAME') ? 'focus-into-iframe' : 'window-blur');
    }, 0);
  });
  on(window, 'focus', (e) => { if (e.target === window) record('window-focus'); });
  on(document, 'visibilitychange', () => record(document.hidden ? 'hidden' : 'visible'));
  on(window, 'pagehide', () => record('pagehide'));
  on(document, 'freeze', () => record('freeze'));
  on(document, 'resume', () => record('resume'));
  on(document, 'fullscreenchange', () => record(document.fullscreenElement ? 'fullscreen-on' : 'fullscreen-off'));

  const observer = new MutationObserver((list) => { A.mutations += list.length; });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  A.dispose = () => {
    ac.abort();
    observer.disconnect();
  };

  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'VIDEO', 'AUDIO']);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'slider', 'spinbutton', 'textbox', 'searchbox', 'combobox', 'listbox', 'treeitem', 'gridcell',
  ]);

  const clip = (s, n = 80) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  function idOf(el) {
    let id = A.ids.get(el);
    if (!id) { id = A.next++; A.ids.set(el, id); }
    A.refs.set(id, el);
    return id;
  }

  function roleOf(el, pointer) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'IFRAME') return 'iframe';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (['checkbox', 'radio', 'range', 'file', 'color', 'date'].includes(t)) return t;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    if (pointer) return 'clickable';
    return tag.toLowerCase();
  }

  function nameOf(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const txt = by.split(/\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' ');
      if (txt.trim()) return clip(txt);
    }
    const direct = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title');
    if (direct) return clip(direct);
    if (el.labels && el.labels.length) return clip(el.labels[0].textContent);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return clip(el.placeholder || el.name || '');
    if (el.tagName === 'IFRAME') return clip(el.title || el.src);
    return clip(el.innerText !== undefined ? el.innerText || el.textContent : el.textContent);
  }

  function stateOf(el) {
    const s = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.checked || el.getAttribute('aria-checked') === 'true') s.push('checked');
    if (el.selected || el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
    const exp = el.getAttribute('aria-expanded');
    if (exp) s.push(exp === 'true' ? 'expanded' : 'collapsed');
    if (el === document.activeElement) s.push('focused');
    if (el.classList && [...el.classList].some((c) => /^(active|selected|checked|on|current)$/i.test(c))) s.push('active-class');
    const toggle = el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');
    if ('value' in el && !toggle && el.tagName !== 'BUTTON' && el.tagName !== 'LI' && el.value) s.push(`value="${clip(String(el.value), 40)}"`);
    return s;
  }

  function* walk(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
      if (node !== root) yield node;
      if (node.shadowRoot) stack.push(node.shadowRoot);
    }
  }

  // Elements that a user could interact with, including non-semantic ones of custom players.
  function collect({ max = 150, hidden = false } = {}) {
    for (const [id, el] of A.refs) if (!el.isConnected) A.refs.delete(id);
    const items = [];
    let scanned = 0;
    const root = document.body || document.documentElement;
    if (!root) return { items, truncated: false };
    for (const el of walk(root)) {
      if (++scanned > 8000 || items.length >= max) break;
      const cs = getComputedStyle(el);
      const pointer = cs.cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer');
      const role = el.getAttribute('role');
      const semantic =
        INTERACTIVE_TAGS.has(el.tagName) ||
        (role && INTERACTIVE_ROLES.has(role)) ||
        el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable) ||
        (el.hasAttribute('tabindex') && el.tabIndex >= 0) ||
        el.hasAttribute('onclick');
      if (!semantic && !pointer) continue;
      if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
      const r = el.getBoundingClientRect();
      const sized = r.width > 2 && r.height > 2;
      const shown = el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : cs.visibility !== 'hidden';
      const opaque = el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : shown;
      // Invisible (opacity 0) controls with a real size are typically an accessibility layer
      // lying over drawn shapes (players like Storyline). They are the real click targets.
      const overlay = sized && shown && !opaque && semantic;
      const visible = sized && shown && opaque;
      if (!visible && !overlay && !hidden) continue;
      let why = null;
      if (!visible && !overlay) {
        const displayed = el.checkVisibility ? el.checkVisibility() : true;
        why = !sized ? 'geen afmeting' : !displayed ? 'display' : !shown ? 'visibility' : !opaque ? 'opacity' : 'onbekend';
      }
      items.push({
        why,
        id: idOf(el),
        role: roleOf(el, pointer),
        name: nameOf(el),
        state: stateOf(el),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        hidden: !visible && !overlay,
        overlay,
      });
    }
    return { items, truncated: items.length >= max };
  }

  function textLines() {
    const root = document.body;
    if (!root) return [];
    const lines = (root.innerText || '').split('\n').map((l) => clip(l, 120)).filter(Boolean);
    // SVG text is not always part of innerText.
    for (const t of root.querySelectorAll('svg text')) {
      const s = clip(t.textContent, 120);
      if (s && !lines.includes(s)) lines.push(s);
    }
    return lines.slice(0, 400);
  }

  function describe(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    return { id: idOf(el), role: roleOf(el, false), name: nameOf(el) };
  }

  A.collect = collect;
  A.get = (id) => A.refs.get(id) || null;
  A.has = (id) => !!A.refs.get(id)?.isConnected;
  A.stateOfId = (id) => {
    const el = A.refs.get(id);
    return el && el.isConnected ? stateOf(el).join(' ') : null;
  };
  A.status = () => ({
    url: location.href,
    title: document.title,
    hasFocus: document.hasFocus(),
    hidden: document.hidden,
    fullscreen: !!document.fullscreenElement,
  });
  const STATEFUL = 'input[type=checkbox],input[type=radio],select,[aria-checked],[aria-selected],[aria-pressed],[aria-expanded]';

  // Hash of all element attributes (not text): catches changes that are only drawn,
  // such as an SVG checkmark whose fill or class changes.
  function attrHash() {
    let h = 2166136261;
    const mix = (s) => {
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    };
    const all = (document.body || document.documentElement)?.getElementsByTagName('*') || [];
    const n = Math.min(all.length, 20000);
    for (let i = 0; i < n; i++) {
      const el = all[i];
      mix(el.tagName);
      for (const a of el.attributes) mix(a.name + '=' + a.value);
      if (el.checked) mix('checked');
    }
    return h >>> 0;
  }

  A.fingerprint = () => {
    const states = {};
    // Every checkbox/radio/toggle counts, also when no snapshot has listed it yet.
    let k = 0;
    for (const el of document.querySelectorAll(STATEFUL)) {
      if (++k > 300) break;
      idOf(el);
    }
    // Focus is reported separately; it is not a state change of the element.
    for (const [id, el] of A.refs) if (el.isConnected) states[id] = stateOf(el).filter((t) => t !== 'focused').join(' ');
    return {
      url: location.href,
      title: document.title,
      mutations: A.mutations,
      lines: textLines(),
      states,
      focused: describe(document.activeElement),
      hasFocus: document.hasFocus(),
      hidden: document.hidden,
      fullscreen: !!document.fullscreenElement,
      viewport: [innerWidth, innerHeight],
      attrs: attrHash(),
      events: A.events.length,
    };
  };
  A.summary = (n = 600) => textLines().join(' | ').slice(0, n);
  A.eventsSince = (t) => A.events.filter((e) => e.t >= t);
  A.hasText = (needle) => {
    const n = needle.toLowerCase();
    return textLines().some((l) => l.toLowerCase().includes(n));
  };

  window.__iframeAgent = A;
}

// Version = hash of the helper's own source, so every code change replaces stale helpers.
const SOURCE = install.toString();
let h = 2166136261;
for (let i = 0; i < SOURCE.length; i++) h = Math.imul(h ^ SOURCE.charCodeAt(i), 16777619);
export const AGENT_VERSION = (h >>> 0).toString(16);
export const INJECTED_SOURCE = `(${SOURCE})(${JSON.stringify(AGENT_VERSION)});`;
