// Helpers shared by init and update.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GITIGNORE_ENTRIES, MANIFEST_PATH, SETTINGS_PATH, USAGE_HOOK_COMMAND } from './util.js';

export function writeFile(root, rel, content) {
  const dest = join(root, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
}

export function readManifest(root) {
  const path = join(root, MANIFEST_PATH);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { version: null, files: {} };
  }
}

export function writeManifest(root, manifest) {
  writeFile(root, MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Appends any missing factory entries to .gitignore. Returns the entries added. */
export function ensureGitignore(root) {
  const path = join(root, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !lines.has(e));
  if (!missing.length) return [];
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  const header = current.includes('# software-factory') ? '' : `${current ? '\n' : ''}# software-factory\n`;
  writeFileSync(path, `${current}${sep}${header}${missing.join('\n')}\n`);
  return missing;
}

/**
 * Registers the SubagentStop hook that records what each factory agent costs, in the
 * project's Claude Code settings. Returns 'added', 'present' or an error message.
 */
export function ensureUsageHook(root) {
  const path = join(root, SETTINGS_PATH);
  let settings = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return `${SETTINGS_PATH} isn't valid JSON, so the cost-tracking hook wasn't added`;
    }
  }
  if (JSON.stringify(settings.hooks || {}).includes('factory/usage.mjs')) return 'present';
  settings.hooks ||= {};
  settings.hooks.SubagentStop ||= [];
  settings.hooks.SubagentStop.push({
    matcher: '^factory-',
    hooks: [{ type: 'command', command: USAGE_HOOK_COMMAND, async: true }],
  });
  writeFile(root, SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  return 'added';
}

/**
 * Adds keys present in `defaults` but missing from `target`, recursing into plain
 * objects. Never changes an existing value. Returns the dotted paths it added.
 */
export function mergeDefaults(target, defaults, prefix = '') {
  const added = [];
  for (const [key, value] of Object.entries(defaults)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in target)) {
      target[key] = value;
      added.push(path);
    } else if (isPlainObject(value) && isPlainObject(target[key])) {
      added.push(...mergeDefaults(target[key], value, path));
    }
  }
  return added;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
