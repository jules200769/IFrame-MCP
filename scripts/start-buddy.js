// Start the buddy window (Electron). Usage: npm run buddy
// Removes ELECTRON_RUN_AS_NODE, which editors such as VS Code/Cursor pass on to child processes;
// with it set, Electron would start as plain Node and fail to open a window.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [path.join(ROOT, 'buddy/electron/main.js'), ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
