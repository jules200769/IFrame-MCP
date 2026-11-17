// Electron shell for the buddy: one frameless window that stays above everything, including
// Chrome in fullscreen. It is a separate process, so using it only deactivates the Chrome
// window; Chrome keeps its fullscreen and the page keeps (emulated) focus via the buddy's
// CDP connection, which starts here before the window is shown.
import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBuddyServer } from '../server.js';
import { createCapture } from './capture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BUDDY_PORT || 5199);
// Never Escape: in Chrome, Escape ends fullscreen.
const HOTKEY = process.env.BUDDY_HOTKEY || 'CommandOrControl+Shift+Space';
const BUBBLE = 64;
const SIZE = { width: 400, height: 600 };

let win = null;
let server = null;
let collapsed = false;
let expandedBounds = null;
const stateFile = () => path.join(app.getPath('userData'), 'buddy-window.json');

function loadBounds() {
  try {
    if (existsSync(stateFile())) {
      const b = JSON.parse(readFileSync(stateFile(), 'utf8'));
      // Only reuse a position that is still on a connected display.
      const d = screen.getDisplayMatching(b);
      const wa = d.workArea;
      if (b.x >= wa.x - 50 && b.y >= wa.y - 50 && b.x < wa.x + wa.width && b.y < wa.y + wa.height) return b;
    }
  } catch {
    // fall through to the default spot
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return { ...SIZE, x: wa.x + wa.width - SIZE.width - 24, y: wa.y + wa.height - SIZE.height - 24 };
}
function saveBounds() {
  if (!win || collapsed) return;
  try {
    writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
  } catch {
    // not important
  }
}

function keepOnTop() {
  if (!win) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function setCollapsed(c) {
  if (!win || c === collapsed) return;
  if (c) {
    expandedBounds = win.getBounds();
    collapsed = true;
    const b = expandedBounds;
    win.setResizable(false);
    win.setBounds({ x: b.x + b.width - BUBBLE, y: b.y + b.height - BUBBLE, width: BUBBLE, height: BUBBLE });
  } else {
    const bub = win.getBounds();
    const size = expandedBounds || SIZE;
    collapsed = false;
    win.setResizable(true);
    // Grow from the bubble's bottom-right corner, kept inside the display.
    const wa = screen.getDisplayMatching(bub).workArea;
    const x = Math.max(wa.x, Math.min(bub.x + BUBBLE - size.width, wa.x + wa.width - size.width));
    const y = Math.max(wa.y, Math.min(bub.y + BUBBLE - size.height, wa.y + wa.height - size.height));
    win.setBounds({ x, y, width: size.width, height: size.height });
  }
  keepOnTop();
}

async function startServer() {
  try {
    server = await startBuddyServer({ port: PORT, capture: createCapture() });
    return server.url;
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      // A buddy server (npm run buddy:server) is already running: use that one.
      return `http://127.0.0.1:${PORT}/`;
    }
    throw e;
  }
}

async function createWindow() {
  const url = await startServer();
  win = new BrowserWindow({
    ...loadBounds(),
    minWidth: BUBBLE,
    minHeight: BUBBLE,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#171a21',
    title: 'iframe-buddy',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  keepOnTop();
  // Keep the buddy out of every screen capture, including its own "look" tool.
  win.setContentProtection(true);
  win.on('blur', keepOnTop);
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('closed', () => {
    win = null;
  });
  // Show without activating: Chrome keeps OS focus until the user clicks into the buddy.
  if (!process.env.BUDDY_SMOKE) win.once('ready-to-show', () => win.showInactive());
  await win.loadURL(url);
  if (process.env.BUDDY_SMOKE) {
    // Start-up check without showing a window: loads the UI and reports, then quits.
    const bridge = await win.webContents.executeJavaScript('typeof window.buddyWindow?.collapse');
    let shot = 'none';
    try {
      const s = await createCapture()({});
      shot = s.data ? 'ok' : 'none';
    } catch (e) {
      shot = `none (${e.message.split('\n')[0]})`;
    }
    console.log(`BUDDY_SMOKE ok url=${url} alwaysOnTop=${win.isAlwaysOnTop()} bridge=${bridge} title=${win.webContents.getTitle()} capture=${shot}`);
    app.quit();
  }
}

ipcMain.on('buddy:collapse', () => setCollapsed(true));
ipcMain.on('buddy:expand', () => setCollapsed(false));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    win?.show();
    win?.focus();
  });
  app.whenReady().then(async () => {
    await createWindow();
    const ok = globalShortcut.register(HOTKEY, () => {
      if (!win) return;
      setCollapsed(false);
      win.show();
      win.moveTop();
      win.focus();
      win.webContents.send('buddy:focus-input');
    });
    if (!ok) console.warn(`Sneltoets ${HOTKEY} is al in gebruik; zet BUDDY_HOTKEY op een andere combinatie.`);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    server?.close().catch(() => {});
  });
}
