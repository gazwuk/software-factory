#!/usr/bin/env node
// Shared factory state that more than one process may write: board.json, job ids and
// the backlog. Every write happens under a lock in factory/.locks/, so the runner, the
// /factory session and `approve`/`rework` can work side by side.
//
//   node board.mjs update <job-id> '<json>'   merge fields into one job (adds it if new)
//   node board.mjs claim-id <slug>            create factory/jobs/<nnn>-<slug>/ and print the id
//   node board.mjs runner                     print the live runner's pid, or nothing
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WAIT_MS = 30_000;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---------- locks ----------

export const lockPath = (root, name) => join(root, 'factory/.locks', name);

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

const readPid = (path) => Number(readFileSync(join(path, 'pid'), 'utf8').trim());
const unique = (path) => `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;

/** The pid holding a lock, or null if its holder has exited. Throws if there's no lock. */
export function lockHolder(path) {
  const pid = readPid(path);
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
}

/**
 * Takes a lock once, taking over one whose holder has exited. Returns true if this
 * process now holds it. The lock folder is built with its pid file inside and renamed
 * into place, so no process ever sees a lock without its holder.
 */
export function tryLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = unique(path);
  mkdirSync(tmp);
  writeFileSync(join(tmp, 'pid'), String(process.pid));
  try {
    renameSync(tmp, path);
    return true;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(err.code)) throw err;
  }
  let stale;
  try { stale = readPid(path); } catch { return false; } // released meanwhile; try again
  if (Number.isInteger(stale) && stale > 0 && alive(stale)) return false;
  // Move the stale lock aside first, so two processes can't both take it over.
  const moved = unique(path);
  try { renameSync(path, moved); } catch { return false; }
  let same = false;
  try { same = readPid(moved) === stale || Number.isNaN(stale); } catch { /* unreadable: treat as moved by mistake */ }
  if (!same) {
    try { renameSync(moved, path); } catch { /* a newer lock is there already */ }
    return false;
  }
  rmSync(moved, { recursive: true, force: true });
  return tryLock(path);
}

/** Releases a lock: moved aside first, because an empty folder could be renamed over mid-delete. */
export function unlock(path) {
  const moved = unique(path);
  try { renameSync(path, moved); } catch { return; } // not held
  rmSync(moved, { recursive: true, force: true });
}

/** Runs fn holding a short-lived lock, waiting up to 30s for it. */
export function withLock(path, fn) {
  const deadline = Date.now() + WAIT_MS;
  while (!tryLock(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(PAUSE, 0, 0, 25);
  }
  try { return fn(); } finally { unlock(path); }
}

/** Like withLock, but waits as long as it takes without blocking the event loop. */
export async function withLockAsync(path, fn, { signal } = {}) {
  while (!tryLock(path)) {
    signal?.throwIfAborted();
    await new Promise((r) => setTimeout(r, 250));
  }
  try { return await fn(); } finally { unlock(path); }
}

// ---------- board ----------

const boardPath = (root) => join(root, 'factory/board.json');

export function readBoard(root) {
  const board = readJson(boardPath(root));
  return board && Array.isArray(board.jobs) ? board : { version: 1, jobs: [] };
}

export const getJob = (root, id) => readBoard(root).jobs.find((j) => j.id === id) || null;

/**
 * Changes one job on the board and returns it. `patch` is an object of fields to set,
 * or a function that edits the job in place. A job that isn't on the board is added.
 */
export function updateJob(root, id, patch) {
  return withLock(lockPath(root, 'board'), () => {
    const board = readBoard(root);
    let job = board.jobs.find((j) => j.id === id);
    if (!job) board.jobs.push((job = { id, createdAt: now() }));
    if (typeof patch === 'function') patch(job);
    else Object.assign(job, patch);
    job.updatedAt = now();
    writeJsonAtomic(boardPath(root), board);
    return job;
  });
}

// ---------- job ids ----------

export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 5).join('-') || 'job';
}

const numberOf = (id) => Number(/^(\d+)-/.exec(id)?.[1] || 0);

/** Creates the next job folder, factory/jobs/<nnn>-<slug>/, and returns its id. */
export function claimJobId(root, slug) {
  const jobsDir = join(root, 'factory/jobs');
  mkdirSync(jobsDir, { recursive: true });
  return withLock(lockPath(root, 'ids'), () => {
    const taken = [...readBoard(root).jobs.map((j) => j.id), ...readdirSync(jobsDir)];
    for (let n = Math.max(0, ...taken.map(numberOf)) + 1; ; n++) {
      const id = `${String(n).padStart(3, '0')}-${slug}`;
      try {
        mkdirSync(join(jobsDir, id));
        return id;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  });
}

// ---------- backlog ----------

/**
 * The unchecked items in backlog.md, in order. An item is a `- [ ] ` line plus the
 * indented lines directly under it; anything inside an HTML comment is ignored.
 */
export function parseBacklog(text) {
  const lines = text.split('\n');
  const masked = text.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');
  const items = [];
  for (let i = 0; i < masked.length; i++) {
    const m = /^- \[ \] (.*\S)/.exec(masked[i]);
    if (!m) continue;
    const body = [];
    while (i + 1 < masked.length && /^\s+\S/.test(masked[i + 1])) body.push(lines[++i].trim());
    items.push({ line: i - body.length, text: m[1], request: [m[1], ...body].join('\n') });
  }
  return items;
}

/**
 * Claims the first unchecked backlog item: makes its job id with idFor(text), ticks it
 * off as `- [x] <text> (job <id>)`, and returns { id, text, request }. Null when empty.
 */
export function claimBacklogItem(root, idFor) {
  const path = join(root, 'factory/backlog.md');
  return withLock(lockPath(root, 'backlog'), () => {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf8');
    const [item] = parseBacklog(text);
    if (!item) return null;
    const id = idFor(item.text);
    const lines = text.split('\n');
    lines[item.line] = `- [x] ${item.text} (job ${id})`;
    writeFileSync(path, lines.join('\n'));
    return { id, text: item.text, request: item.request };
  });
}

// ---------- entry point ----------

function main() {
  const [command, ...args] = process.argv.slice(2);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (command === 'update' && args.length === 2) updateJob(root, args[0], JSON.parse(args[1]));
  else if (command === 'claim-id' && args.length === 1) console.log(claimJobId(root, slugify(args[0])));
  else if (command === 'runner') {
    const path = lockPath(root, 'runner');
    let pid = null;
    try { pid = existsSync(path) ? lockHolder(path) : null; } catch { /* stale */ }
    if (pid) console.log(pid);
  } else {
    console.error("Usage: node board.mjs update <job-id> '<json>' | claim-id <slug> | runner");
    process.exitCode = 2;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) { console.error(`board.mjs: ${err.message}`); process.exitCode = 1; }
}
