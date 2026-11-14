#!/usr/bin/env node
// Makes a fresh worktree runnable. A worktree holds only committed files, so anything
// gitignored the app or its tests need (.env files, node_modules, generated code) is
// missing. config.worktree fixes that:
//
//   "worktree": { "link": [".env.local"], "setup": "npm ci --prefer-offline" }
//
// - link: paths in the main checkout to symlink into the worktree. Each must be
//   gitignored, so it can't be committed from the worktree.
// - setup: a command run once in the worktree (install packages, generate code).
//
//   node .claude/skills/factory/worktree.mjs <job-id>
//
// prepares .factory-worktrees/<job-id>, records that it's ready in the worktree's
// private git folder (so a runner that stopped part-way prepares it again), and
// prints one line of JSON: { ok, links, skipped, setup, error }.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAIL_LINES = 15;

/** Where a worktree's "ready" marker lives: its private git folder, outside the work tree. */
export function readyMarker(dir) {
  const dotGit = join(dir, '.git');
  try {
    if (lstatSync(dotGit).isDirectory()) return join(dotGit, 'factory-ready');
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1].trim();
    return gitdir ? join(resolve(dir, gitdir), 'factory-ready') : null;
  } catch {
    return null;
  }
}

export const isReady = (dir) => {
  const marker = readyMarker(dir);
  return Boolean(marker && existsSync(marker));
};

const ignored = (dir, path) => spawnSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: dir }).status === 0;

/** Symlinks each `link` path from root into dir. Returns { links, skipped, error }. */
export function linkFiles(root, dir, link = []) {
  const links = [];
  const skipped = [];
  for (const path of link) {
    const source = resolve(root, path);
    const rel = relative(root, source);
    if (isAbsolute(path) || !rel || rel.startsWith('..')) return { links, skipped, error: `worktree.link "${path}" must be a path inside the repo` };
    const dest = join(dir, rel);
    if (!existsSync(source)) { skipped.push(`${rel} (not in the main checkout)`); continue; }
    let present = null;
    try { present = lstatSync(dest); } catch { /* not there */ }
    if (present) {
      if (present.isSymbolicLink() && resolve(dirname(dest), readlinkSync(dest)) === source) links.push(rel);
      else skipped.push(`${rel} (the worktree already has it)`);
      continue;
    }
    if (!ignored(dir, rel)) {
      // A linked folder is a symlink, which git sees as a file: `name/` doesn't match it.
      const hint = lstatSync(source).isDirectory() ? ` (for a folder, ignore \`${rel}\` without a trailing slash)` : '';
      return { links, skipped, error: `worktree.link "${rel}" isn't gitignored in the worktree, so it could be committed from there${hint}` };
    }
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(source, dest);
    links.push(rel);
  }
  return { links, skipped, error: null };
}

/** Removes the links linkFiles made, so deleting the worktree can't reach their targets. */
export function unlinkFiles(dir, links) {
  for (const rel of links) {
    try { if (lstatSync(join(dir, rel)).isSymbolicLink()) unlinkSync(join(dir, rel)); } catch { /* gone */ }
  }
}

/** Runs the setup command in dir. Returns { command, exit, seconds, output }. */
export function runSetup(dir, command) {
  const started = Date.now();
  const r = spawnSync(command, {
    cwd: dir, shell: true, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: process.env.CI || 'true' },
  });
  const output = [r.stdout, r.stderr, r.error?.message].filter(Boolean).join('\n').replace(/\s+$/, '').split('\n').slice(-TAIL_LINES).join('\n');
  return { command, exit: r.status ?? 1, seconds: Math.round((Date.now() - started) / 1000), output };
}

/** Links files and runs setup in dir. Writes the ready marker when `mark` and all went well. */
export function prepareWorktree(root, dir, settings = {}, { mark = false } = {}) {
  const { links, skipped, error } = linkFiles(root, dir, settings.link || []);
  const result = { ok: !error, links, skipped, setup: null, error };
  if (error) return result;
  if (settings.setup) {
    result.setup = runSetup(dir, settings.setup);
    if (result.setup.exit !== 0) {
      result.ok = false;
      const last = result.setup.output.split('\n').filter(Boolean).pop() || '';
      result.error = `\`${settings.setup}\` failed (exit ${result.setup.exit})${last ? `: ${last}` : ''}`;
      return result;
    }
  }
  if (mark) {
    const marker = readyMarker(dir);
    if (!marker) return { ...result, ok: false, error: `${dir} has no .git to record that it's ready in` };
    writeFileSync(marker, `${JSON.stringify({ links, setup: settings.setup || null, at: new Date().toISOString() })}\n`);
  }
  return result;
}

function main() {
  const [id] = process.argv.slice(2);
  if (!id || !/^[\w.-]+$/.test(id)) {
    console.error('Usage: node worktree.mjs <job-id>');
    process.exit(2);
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).stdout.trim();
    const config = JSON.parse(readFileSync(join(root, 'factory/config.json'), 'utf8'));
    const dir = join(root, '.factory-worktrees', id);
    if (!existsSync(dir)) throw new Error(`worktree ${dir} doesn't exist`);
    const result = prepareWorktree(root, dir, config.worktree || {}, { mark: true });
    if (result.setup) delete result.setup.output; // in the error when it matters
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(`worktree.mjs: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) main();
