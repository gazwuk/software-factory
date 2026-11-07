#!/usr/bin/env node
// Shared factory state that more than one process may write: board.json, job ids and
// the backlog. Every write happens under a lock in factory/.locks/, so the runner, the
// /factory session and `approve`/`rework` can work side by side.
//
//   node board.mjs update <job-id> '<json>'   merge fields into one job (adds it if new)
//   node board.mjs claim-id <slug>            create factory/jobs/<nnn>-<slug>/ and print the id
//   node board.mjs backlog-add <file>         append a file's tasks to backlog.md
//   node board.mjs runner                     print each live runner process, or nothing
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

// Creates a lock folder already holding this pid, in one rename, so no process ever
// sees a lock without its holder. False if the lock exists.
function create(path) {
  const tmp = unique(path);
  mkdirSync(tmp);
  writeFileSync(join(tmp, 'pid'), String(process.pid));
  try {
    renameSync(tmp, path);
    return true;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(err.code)) return false;
    throw err;
  }
}

/**
 * Takes a lock once, taking over one whose holder has exited. Returns true if this
 * process now holds it.
 *
 * A stale lock is cleared only by the process that creates its reclaim marker
 * (`<lock>.reclaim-<dead pid>`), and only if the lock still names that dead pid, so a
 * live holder is never displaced. If a reclaimer dies mid-takeover its marker stays,
 * and the lock needs removing by hand (withLock's timeout names it).
 */
export function tryLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (create(path)) return true;
  let stale;
  try { stale = readPid(path); } catch { return false; } // released meanwhile; try again
  if (Number.isInteger(stale) && stale > 0 && alive(stale)) return false;
  const marker = `${path}.reclaim-${stale}`;
  if (!create(marker)) return false;
  try {
    let now = null;
    try { now = readPid(path); } catch { /* already cleared */ }
    if (!Object.is(now, stale)) return false;
    unlock(path);
  } finally {
    unlock(marker);
  }
  return create(path);
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
  try {
    signal?.throwIfAborted(); // stopped while waiting: don't run fn
    return await fn();
  } finally {
    unlock(path);
  }
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
 * Claims the first unchecked backlog item and ticks it off as `- [x] <text> (job <id>)`.
 * claim(item) creates the job and returns { id }, or returns { id, existing: true } for
 * an item a job already took before a crash stopped the tick; that item is ticked and
 * the next one claimed. Returns { id, text, request } for the new job, or null.
 */
export function claimBacklogItem(root, claim) {
  const path = join(root, 'factory/backlog.md');
  return withLock(lockPath(root, 'backlog'), () => {
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, 'utf8').split('\n');
    let claimed = null;
    for (const item of parseBacklog(lines.join('\n'))) {
      const { id, existing } = claim(item);
      lines[item.line] = `- [x] ${item.text} (job ${id})`;
      if (!existing) {
        claimed = { id, text: item.text, request: item.request };
        break;
      }
    }
    writeFileSync(path, lines.join('\n'));
    return claimed;
  });
}

/** Appends markdown to backlog.md under the lock that claims use. */
export function appendBacklog(root, text) {
  const path = join(root, 'factory/backlog.md');
  withLock(lockPath(root, 'backlog'), () => {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const sep = !current || current.endsWith('\n') ? '' : '\n';
    writeFileSync(path, `${current}${sep}${text.replace(/\s*$/, '\n')}`);
  });
}

/** Live runner processes: the scheduler (`run`) and any process driving one job. */
export function liveWorkers(root) {
  const dir = join(root, 'factory/.locks');
  const out = [];
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const m = /^(runner|job-([a-z0-9-]+))$/.exec(name); // not temp names, markers or agent lists
    if (!m) continue;
    let pid = null;
    try { pid = lockHolder(join(dir, name)); } catch { /* just released */ }
    if (pid) out.push(m[2] ? { job: m[2], pid } : { runner: true, pid });
  }
  return out;
}

// ---------- entry point ----------

function main() {
  const [command, ...args] = process.argv.slice(2);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (command === 'update' && args.length === 2) updateJob(root, args[0], JSON.parse(args[1]));
  else if (command === 'claim-id' && args.length === 1) console.log(claimJobId(root, slugify(args[0])));
  else if (command === 'backlog-add' && args.length === 1) appendBacklog(root, readFileSync(args[0], 'utf8'));
  else if (command === 'runner') {
    for (const w of liveWorkers(root)) console.log(w.runner ? `runner ${w.pid}` : `job ${w.job} ${w.pid}`);
  } else {
    console.error("Usage: node board.mjs update <job-id> '<json>' | claim-id <slug> | backlog-add <file> | runner");
    process.exitCode = 2;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) { console.error(`board.mjs: ${err.message}`); process.exitCode = 1; }
}
