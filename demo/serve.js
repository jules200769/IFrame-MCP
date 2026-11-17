// Demo: a "portal" page on localhost that embeds a weather app from 127.0.0.1.
// Different sites => the iframe is cross-origin and runs out-of-process (OOPIF),
// the hardest case for an agent.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function html(file) {
  return readFileSync(path.join(DIR, file), 'utf8');
}

function serve(port, host, handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = handler(req);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    });
    server.listen(port, host, () => resolve(server));
  });
}

export async function startDemo({ hostPort = 5173, appPort = 5174 } = {}) {
  const appUrl = `http://127.0.0.1:${appPort}/`;
  const app = await serve(appPort, '127.0.0.1', (req) => {
    const url = new URL(req.url || '/', appUrl);
    if (url.pathname === '/nested.html') return html('nested.html');
    if (url.pathname === '/kind.html') return html('kind.html');
    if (url.pathname === '/kind-noscript.html') return html('kind-noscript.html');
    return html('app.html');
  });
  const host = await serve(hostPort, 'localhost', () => html('host.html').replace('{{APP_URL}}', appUrl));
  return {
    hostUrl: `http://localhost:${hostPort}/`,
    appUrl,
    close: () => Promise.all([new Promise((r) => app.close(r)), new Promise((r) => host.close(r))]),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = await startDemo();
  console.log(`Portaal:  ${demo.hostUrl}`);
  console.log(`Weerapp:  ${demo.appUrl} (draait in de iframe)`);
  console.log('Stoppen met Ctrl+C.');
}
