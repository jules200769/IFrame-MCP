// Finding the CDP endpoint of the user's everyday Chrome.
// Since Chrome 144 the user can allow remote debugging of the running browser at
// chrome://inspect/#remote-debugging. Chrome then writes DevToolsActivePort (port on line 1,
// browser WebSocket path on line 2) into its user data dir and asks for permission on every
// new connection. There is no HTTP /json endpoint in that mode, only the WebSocket.
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENABLE_HINT =
  'Zet in je Chrome remote debugging aan: open chrome://inspect/#remote-debugging en zet de schakelaar aan (Chrome 144 of nieuwer). ' +
  'Chrome vraagt daarna bij het koppelen om toestemming.';

export function chromeUserDataDir(env = process.env, platform = process.platform) {
  if (env.CHROME_USER_DATA_DIR) return env.CHROME_USER_DATA_DIR;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'google-chrome');
}

export function parseDevToolsActivePort(text) {
  const [portLine, pathLine] = String(text).split(/\r?\n/).map((l) => l.trim());
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`DevToolsActivePort bevat geen geldige poort ("${portLine}").`);
  if (!pathLine || !pathLine.startsWith('/devtools/browser/')) throw new Error('DevToolsActivePort bevat geen browserpad.');
  return { port, path: pathLine, wsEndpoint: `ws://127.0.0.1:${port}${pathLine}` };
}

export function readDevToolsActivePort(dir = chromeUserDataDir()) {
  const file = path.join(dir, 'DevToolsActivePort');
  if (!existsSync(file)) throw new Error(`Geen DevToolsActivePort in ${dir}. ${ENABLE_HINT}`);
  return parseDevToolsActivePort(readFileSync(file, 'utf8'));
}
