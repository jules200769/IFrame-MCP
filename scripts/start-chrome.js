// Start a dedicated Chrome instance that the agent can drive over CDP.
// Usage: node scripts/start-chrome.js [url]   (env: CDP_PORT, CHROME_PATH, CHROME_PROFILE)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Outside the project (which may sit in OneDrive): a Chrome profile is thousands of locked files.
export const DEFAULT_PROFILE = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'iframe-agent', 'chrome-profile')
  : path.join(ROOT, '.chrome-profile');

// Flags that keep the page "awake" when the Chrome window is covered or not focused.
// Without them Chrome throttles timers, stops rendering (screenshots hang) and may
// report the page as hidden, which makes apps pause.
export const KEEP_ALIVE_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
];

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome niet gevonden. Zet CHROME_PATH naar chrome.exe.');
  return found;
}

export async function cdpVersion(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function launchChrome({
  port = 9222,
  profileDir = DEFAULT_PROFILE,
  headless = false,
  url = 'about:blank',
  detached = false,
} = {}) {
  mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...KEEP_ALIVE_FLAGS,
    ...(headless ? ['--headless=new', '--window-size=1280,900'] : []),
    url,
  ];
  const child = spawn(findChrome(), args, {
    detached,
    stdio: 'ignore',
  });
  if (detached) child.unref();

  for (let i = 0; i < 100; i++) {
    if (await cdpVersion(port)) return child;
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error(`Chrome reageert niet op poort ${port}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.CDP_PORT || 9222);
  const url = process.argv[2] || 'about:blank';
  if (await cdpVersion(port)) {
    console.log(`Chrome draait al met CDP op poort ${port}.`);
  } else {
    await launchChrome({
      port,
      url,
      detached: true,
      profileDir: process.env.CHROME_PROFILE || undefined,
    });
    console.log(`Chrome gestart (CDP op http://127.0.0.1:${port}, profiel ${process.env.CHROME_PROFILE || DEFAULT_PROFILE}).`);
  }
  process.exit(0);
}
