// Serves the shop's pages and its orders API on PORT (3000 by default).
//
// In development, `?state=empty` or `?state=error` on an API call makes it return no
// orders or fail, so those states can be seen (js/api.js passes the page's `state`).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

let orders = [
  { id: 1, customer: 'Ada Lovelace', items: 3, total: 42.5, status: 'Shipped', placed: '2026-11-02' },
  { id: 2, customer: 'Alan Turing', items: 1, total: 12, status: 'Processing', placed: '2026-11-08' },
  { id: 3, customer: 'Katherine Johnson', items: 5, total: 96.25, status: 'Delivered', placed: '2026-10-28' },
];
let nextId = 4;

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

async function readBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  try { return JSON.parse(text); } catch { return {}; }
}

async function api(req, res, url) {
  const state = url.searchParams.get('state');
  if (state === 'error') return json(res, 500, { error: 'The orders service is unavailable.' });
  const one = /^\/api\/orders\/(\d+)$/.exec(url.pathname);
  if (url.pathname === '/api/orders' && req.method === 'GET') return json(res, 200, state === 'empty' ? [] : orders);
  if (url.pathname === '/api/orders' && req.method === 'POST') {
    const { customer, total } = await readBody(req);
    if (!String(customer || '').trim()) return json(res, 422, { field: 'customer', error: 'Enter the customer’s name.' });
    if (!(Number(total) > 0)) return json(res, 422, { field: 'total', error: 'Enter a total greater than 0.' });
    const order = { id: nextId++, customer: String(customer).trim(), items: 1, total: Number(total), status: 'Processing', placed: new Date().toISOString().slice(0, 10) };
    orders = [...orders, order];
    return json(res, 201, order);
  }
  if (one && req.method === 'DELETE') {
    orders = orders.filter((o) => o.id !== Number(one[1]));
    return json(res, 204);
  }
  return json(res, 404, { error: 'Not found.' });
}

async function page(res, url) {
  let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!extname(file)) file += '.html';
  const path = normalize(join(ROOT, file));
  try {
    if (!path.startsWith(ROOT) || file.split('/').some((part) => part.startsWith('.'))) throw new Error('hidden');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': TYPES['.html'] });
    res.end('<!doctype html><html lang="en"><title>Not found</title><h1>Not found</h1></html>');
  }
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  (url.pathname.startsWith('/api/') ? api(req, res, url) : page(res, url)).catch(() => json(res, 500, { error: 'Server error.' }));
}).listen(Number(process.env.PORT) || 3000, '127.0.0.1');
