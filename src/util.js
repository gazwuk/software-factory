import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const TEMPLATE_DIR = join(PACKAGE_ROOT, 'template');
export const INSTALL_CMD = 'npx github:gazwuk/software-factory';

export const MANIFEST_PATH = 'factory/.manifest.json';
export const CONFIG_PATH = 'factory/config.json';
export const GITIGNORE_ENTRIES = ['factory/board.json', 'factory/usage.json', '.factory-worktrees/'];
export const SETTINGS_PATH = '.claude/settings.json';
export const USAGE_HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/skills/factory/usage.mjs"';

// Template files the user owns once installed: created if missing, never overwritten.
export const USER_FILES = new Set([
  'factory/config.json',
  'factory/project.md',
  'factory/backlog.md',
  'factory/board.json',
]);

/** An expected failure: printed without a stack trace. */
export class CliError extends Error {}

export function packageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

/** Every file under template/, as sorted repo-relative posix paths. */
export function templateFiles(dir = TEMPLATE_DIR, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...templateFiles(join(dir, entry.name), rel));
    else if (entry.isFile() && entry.name !== '.DS_Store') out.push(rel);
  }
  return out.sort();
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The repo root containing cwd, or null when cwd isn't in a git repo. */
export function repoRoot(cwd) {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    return null;
  }
}

export function hasCommits(root) {
  try {
    git(['rev-parse', '--verify', 'HEAD'], root);
    return true;
  } catch {
    return false;
  }
}
