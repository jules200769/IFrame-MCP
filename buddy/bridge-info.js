// Where the running buddy leaves its port and bridge token, so buddy/bridge-mcp.js (started by
// the user's AI app) can reach it. Outside the project folder (OneDrive) on purpose.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function bridgeInfoFile(env = process.env) {
  if (env.BUDDY_INFO) return env.BUDDY_INFO;
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'iframe-agent', 'buddy.json');
}

export function writeBridgeInfo(file, info) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
}

export function readBridgeInfo(file = bridgeInfoFile()) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Only remove the file when it still belongs to this buddy (another one may have started since).
export function removeBridgeInfo(file, token) {
  if (readBridgeInfo(file)?.token === token) rmSync(file, { force: true });
}
