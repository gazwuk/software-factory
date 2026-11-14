// Starts the dev server on a free port and a Chromium browser for a test file.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { after, before } from 'node:test';
import { chromium } from 'playwright';

const freePort = () => new Promise((done) => {
  const srv = createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => done(port));
  });
});

/** Returns { url, page() } for the tests in this file. */
export function app() {
  const ctx = { url: null, browser: null, server: null };
  before(async () => {
    const port = await freePort();
    ctx.server = spawn(process.execPath, ['serve.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    ctx.url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try { await fetch(ctx.url); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    ctx.browser = await chromium.launch();
  });
  after(async () => {
    await ctx.browser?.close();
    ctx.server?.kill();
  });
  return {
    get url() { return ctx.url; },
    page: () => ctx.browser.newPage(),
  };
}
