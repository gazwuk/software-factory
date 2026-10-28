import { spawn } from 'node:child_process';
import { existsSync, readFile, stat } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { CliError, INSTALL_CMD, repoRoot } from './util.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const PORT_TRIES = 10;

/** Serves factory/ on localhost. Resolves with the server once it's listening. */
export async function dashboard(cwd, { port, open = true } = {}, log = console.log) {
  const root = repoRoot(cwd) ?? cwd;
  const dir = resolve(root, 'factory');
  if (!existsSync(join(dir, 'dashboard.html'))) {
    throw new CliError(`No factory/dashboard.html here. Install the factory first:\n  ${INSTALL_CMD} init`);
  }

  const server = createServer((req, res) => serve(dir, req, res));
  const actualPort = await listen(server, port);
  const url = `http://localhost:${actualPort}/`;
  log(`Factory dashboard: ${url}\nServing ${dir}. Press Ctrl+C to stop.`);
  if (open) openBrowser(url);
  return server;
}

function serve(dir, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (path === '/') path = '/dashboard.html';
  const file = resolve(dir, `.${path}`);
  if (file !== dir && !file.startsWith(dir + sep)) {
    res.writeHead(403).end();
    return;
  }
  stat(file, (err, info) => {
    if (err || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    readFile(file, (readErr, body) => {
      if (readErr) {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });
}

/** Listens on 127.0.0.1. Without an explicit port, tries 4321 and the next few. */
function listen(server, port) {
  const explicit = port !== undefined;
  const first = explicit ? port : 4321;
  return new Promise((resolvePort, reject) => {
    const attempt = (p, triesLeft) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && !explicit && triesLeft > 1) attempt(p + 1, triesLeft - 1);
        else if (err.code === 'EADDRINUSE') reject(new CliError(`Port ${p} is in use. Pick another with --port <number>.`));
        else reject(err);
      };
      server.once('error', onError);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', onError);
        resolvePort(server.address().port);
      });
    };
    attempt(first, explicit ? 1 : PORT_TRIES);
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser available; the URL is already printed.
  }
}
