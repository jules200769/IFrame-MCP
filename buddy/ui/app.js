// Buddy chat UI. Works in the Electron window (window.buddyWindow) and in a normal browser tab.
const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
const send = $('send');
const win = window.buddyWindow || null;
let busy = false;
const tools = new Map(); // tool call id -> <details>
const approvals = new Map(); // approval id -> card
const MODE_TEXT = { kijken: 'kijken', vragen: 'vragen vóór acties', zelf: 'zelf' };

const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
function add(el) {
  const stick = atBottom();
  log.querySelector('.hint')?.remove();
  log.appendChild(el);
  if (stick) log.scrollTop = log.scrollHeight;
  return el;
}
function msg(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  return add(el);
}
const argText = (args) => {
  if (!args || !Object.keys(args).length) return '';
  return Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
};

function toolStart(ev) {
  const d = document.createElement('details');
  d.className = 'tool running';
  const s = document.createElement('summary');
  s.textContent = `${ev.name} ${argText(ev.args)}`.trim();
  d.appendChild(s);
  tools.set(ev.id, d);
  add(d);
}
function toolEnd(ev) {
  let d = tools.get(ev.id);
  if (!d) {
    toolStart(ev);
    d = tools.get(ev.id);
  }
  d.classList.remove('running');
  d.classList.add(ev.isError ? 'err' : 'ok');
  const first = (ev.summary || '').split('\n')[0];
  d.querySelector('summary').textContent += first ? ` → ${first}` : '';
  const pre = document.createElement('pre');
  pre.textContent = ev.summary || '(geen tekst)';
  d.appendChild(pre);
  if (ev.image) {
    const img = document.createElement('img');
    img.alt = 'screenshot';
    img.src = `data:${ev.image.mimeType};base64,${ev.image.data}`;
    d.appendChild(img);
    d.open = true;
  }
}

function approvalCard(ev) {
  const card = document.createElement('div');
  card.className = 'approval';
  const p = document.createElement('p');
  p.append('De buddy wil dit doen: ');
  const code = document.createElement('code');
  code.textContent = `${ev.name} ${argText(ev.args)}`.trim();
  p.append(code);
  const row = document.createElement('div');
  row.className = 'row';
  for (const [label, allow, cls] of [['Toestaan', true, 'allow'], ['Weigeren', false, 'deny']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', () => post('/api/approve', { id: ev.id, allow }).catch((err) => msg('error', err.message)));
    row.append(b);
  }
  card.append(p, row);
  approvals.set(ev.id, card);
  add(card);
  card.querySelector('.allow').focus();
}
function approvalDone(ev) {
  const card = approvals.get(ev.id);
  if (!card) return;
  card.classList.add('answered');
  card.querySelector('p').append(ev.allow ? ' — toegestaan' : ' — geweigerd');
  approvals.delete(ev.id);
}

function setMode(mode) {
  for (const b of document.querySelectorAll('.modes button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
}

function setBusy(b) {
  busy = b;
  document.body.classList.toggle('busy', b);
  send.textContent = b ? 'Stop' : 'Stuur';
  send.classList.toggle('stop', b);
}

function handle(ev) {
  switch (ev.type) {
    case 'hello':
      log.innerHTML = '';
      tools.clear();
      approvals.clear();
      for (const e of ev.history || []) handle(e);
      if (!log.children.length) log.innerHTML = '<p class="hint">Vraag iets over de app in je browser, bv. <em>"Kies Utrecht en ga naar morgen; controleer dat de app niet pauzeerde."</em></p>';
      break;
    case 'user': msg('user', ev.text); setBusy(true); break;
    case 'assistant': msg('assistant', ev.text); break;
    case 'tool_start': toolStart(ev); break;
    case 'tool_end': toolEnd(ev); break;
    case 'error': msg('error', ev.text); break;
    case 'note': msg('note', ev.text); break;
    case 'approval': approvalCard(ev); break;
    case 'approval_done': approvalDone(ev); break;
    case 'mode': setMode(ev.mode); break;
    case 'done':
      if (ev.outcome === 'stopped') msg('note', 'Gestopt.');
      setBusy(false);
      break;
    case 'reset':
      log.innerHTML = '';
      tools.clear();
      approvals.clear();
      setBusy(false);
      break;
  }
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => handle(JSON.parse(m.data));
  es.onerror = () => {
    es.close();
    setTimeout(connect, 1500);
  };
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    throw new Error(error || `HTTP ${res.status}`);
  }
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return post('/api/stop').catch(() => {});
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await post('/api/chat', { text });
  } catch (err) {
    msg('error', err.message);
  }
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('form').requestSubmit();
  }
});
$('reset').addEventListener('click', () => post('/api/reset').catch((err) => msg('error', err.message)));
for (const b of document.querySelectorAll('.modes button')) {
  b.addEventListener('click', () => post('/api/mode', { mode: b.dataset.mode }).then(() => setMode(b.dataset.mode)).catch((err) => msg('error', err.message)));
}
$('connect').addEventListener('click', async () => {
  $('connect').disabled = true;
  msg('note', 'Koppelen… klik in Chrome op "Toestaan".');
  try {
    await post('/api/connect');
    msg('note', 'Gekoppeld aan je Chrome.');
  } catch (err) {
    msg('error', err.message);
  } finally {
    $('connect').disabled = false;
  }
});

// Collapse to a bubble (Electron only; in a browser tab it just hides the panel).
function collapse() {
  document.body.classList.add('collapsed');
  win?.collapse();
}
function expand() {
  document.body.classList.remove('collapsed');
  win?.expand();
  input.focus();
}
$('collapse').addEventListener('click', collapse);
$('bubble').addEventListener('click', expand);
// Escape only reaches this window when the buddy has focus, so Chrome's fullscreen is safe.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.body.classList.contains('collapsed')) collapse();
});
win?.onFocusInput?.(() => {
  document.body.classList.remove('collapsed');
  input.focus();
});

// --- Model menu ---
let presets = [];
const form = $('modelForm');
const presetOf = () => presets.find((p) => p.id === $('preset').value);
function showFields() {
  const p = presetOf();
  if (!p) return;
  const openai = p.provider === 'openai';
  $('modelRow').hidden = p.provider === 'bridge';
  $('baseRow').hidden = !openai;
  $('keyRow').hidden = p.provider === 'bridge';
  $('visionRow').hidden = p.provider === 'bridge';
  $('modelHint').textContent =
    p.provider === 'bridge'
      ? 'Geen model in de buddy: je eigen AI-app (Claude Code, Codex, Cursor, …) met je abonnement is de agent. Start daar de prompt "buddy" van iframe-buddy.'
      : p.provider === 'anthropic'
        ? 'Kies een Claude-model, bv. claude-opus-5-5 of claude-sonnet-5-5. Nodig: een API-key van Claude Console.'
        : 'Kies een model met tool calling. Zonder beeldondersteuning: vink "screenshots" uit.';
}
function choose(id, cur) {
  $('preset').value = id;
  const p = presetOf();
  const same = cur && cur.provider === p.provider && (p.provider !== 'openai' || (cur.baseUrl || '') === (p.baseUrl ?? cur.baseUrl ?? ''));
  $('model').value = same && cur.model ? cur.model : p.model || '';
  $('baseUrl').value = same && cur.baseUrl ? cur.baseUrl : p.baseUrl || '';
  $('vision').checked = cur?.vision !== false;
  showFields();
}
async function openModelMenu() {
  const info = await (await fetch('/api/providers')).json();
  presets = info.presets;
  $('preset').innerHTML = '';
  for (const p of presets) $('preset').append(new Option(p.label, p.id));
  const cur = info.current || {};
  const match =
    presets.find((p) => p.provider === cur.provider && p.provider !== 'openai') ||
    presets.find((p) => p.provider === 'openai' && cur.provider === 'openai' && p.baseUrl && p.baseUrl === cur.baseUrl) ||
    (cur.provider === 'openai' ? presets.find((p) => p.id === 'custom') : presets[0]);
  choose(match.id, cur);
  $('apiKey').value = '';
  $('apiKey').placeholder = cur.hasKey ? 'leeg = huidige key houden' : 'leeg = omgevingsvariabele';
  form.hidden = false;
  $('settings').setAttribute('aria-expanded', 'true');
}
function closeModelMenu() {
  form.hidden = true;
  $('settings').setAttribute('aria-expanded', 'false');
}
$('settings').addEventListener('click', () => (form.hidden ? openModelMenu().catch((e) => msg('error', e.message)) : closeModelMenu()));
$('modelCancel').addEventListener('click', closeModelMenu);
$('preset').addEventListener('change', () => choose($('preset').value, null));
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = presetOf();
  try {
    await post('/api/provider', {
      provider: p.provider,
      model: $('model').value,
      baseUrl: p.provider === 'openai' ? $('baseUrl').value : undefined,
      apiKey: $('apiKey').value || undefined,
      vision: $('vision').checked,
      save: $('save').checked,
    });
    $('apiKey').value = '';
    closeModelMenu();
  } catch (err) {
    $('modelHint').textContent = err.message;
  }
});

async function pollStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    const dot = $('dot');
    const bridgeDown = s.bridge && !s.bridge.connected;
    dot.className = `dot ${!s.chrome && !s.capture ? 'bad' : s.providerError || bridgeDown || !s.chrome ? 'warn' : 'ok'}`;
    const parts = [];
    const which = s.browser === 'user' ? 'je Chrome' : 'eigen Chrome';
    if (!s.chrome) {
      parts.push(s.connecting ? `${which}: wacht op "Toestaan" in Chrome` : `${which} niet gekoppeld${s.capture ? ' (meekijken kan)' : ''}`);
    } else {
      parts.push(`${which}: ${s.tab?.title || 'Chrome'}`);
      if (s.fullscreen) parts.push('volledig scherm');
      parts.push(s.pauses ? `${s.pauses} pauze-events` : 'geen pauzes');
    }
    if (s.bridge) parts.push(s.bridge.connected ? 'AI-app gekoppeld' : 'wacht op AI-app (bridge)');
    else parts.push(s.providerError ? 'geen model' : s.provider);
    parts.push(`modus: ${MODE_TEXT[s.mode] || s.mode}`);
    setMode(s.mode);
    $('connect').hidden = !(s.browser === 'user' && !s.chrome && !s.connecting);
    $('status').textContent = parts.join(' · ');
    $('status').title = s.providerError || s.chromeError || s.tab?.url || '';
  } catch {
    $('dot').className = 'dot bad';
    $('status').textContent = 'buddy-server niet bereikbaar';
  }
  setTimeout(pollStatus, 2000);
}

connect();
pollStatus();
input.focus();
