import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGitignore, ensureUsageHook, mergeDefaults, readManifest, writeFile, writeManifest } from './install.js';
import {
  CONFIG_PATH, CliError, INSTALL_CMD, TEMPLATE_DIR, USER_FILES,
  packageVersion, repoRoot, sha256, templateFiles,
} from './util.js';

export function update(cwd, { force = false } = {}, log = console.log) {
  const root = repoRoot(cwd);
  if (!root) throw new CliError('Not inside a git repository.');
  const manifest = readManifest(root);
  if (!manifest) {
    throw new CliError(`The factory isn't installed here. To install it, run:\n  ${INSTALL_CMD} init`);
  }

  const version = packageVersion();
  const next = { version, files: {} };
  const changes = [];   // [symbol, message]
  const conflicts = [];
  const shipped = templateFiles();

  for (const rel of shipped) {
    const src = readFileSync(join(TEMPLATE_DIR, rel));
    const dest = join(root, rel);

    if (USER_FILES.has(rel)) {
      if (rel === CONFIG_PATH && existsSync(dest)) {
        changes.push(...updateConfig(root, src));
      } else if (!existsSync(dest)) {
        writeFile(root, rel, src);
        changes.push(['+', `${rel} (was missing)`]);
      }
      continue;
    }

    const srcHash = sha256(src);
    if (!existsSync(dest)) {
      writeFile(root, rel, src);
      next.files[rel] = srcHash;
      changes.push(['+', rel]);
      continue;
    }

    const curHash = sha256(readFileSync(dest));
    const known = manifest.files?.[rel];
    if (curHash === srcHash) {
      next.files[rel] = srcHash;
      removeStaleNew(dest);
    } else if (force || curHash === known) {
      writeFile(root, rel, src);
      next.files[rel] = srcHash;
      removeStaleNew(dest);
      changes.push(['~', rel]);
    } else {
      // Edited locally: leave it alone and put the new version beside it.
      writeFile(root, `${rel}.new`, src);
      if (known) next.files[rel] = known;
      conflicts.push(rel);
    }
  }

  const dropped = Object.keys(manifest.files || {}).filter((rel) => !shipped.includes(rel));
  const ignored = ensureGitignore(root);
  if (ignored.length) changes.push(['+', `.gitignore: ${ignored.join(', ')}`]);
  const hook = ensureUsageHook(root);
  if (hook === 'added') changes.push(['+', '.claude/settings.json: SubagentStop hook that records what each agent costs']);
  else if (hook !== 'present') changes.push(['!', hook]);
  writeManifest(root, next);

  const from = manifest.version ? `v${manifest.version}` : 'an unknown version';
  if (!changes.length && !conflicts.length && !dropped.length) {
    log(`Already up to date (v${version}).`);
    return;
  }
  log(`Updated the software factory from ${from} to v${version}\n`);
  for (const [symbol, message] of changes) log(`  ${symbol} ${message}`);
  for (const rel of dropped) log(`  - ${rel} is no longer part of the factory (left in place; delete it if unused)`);
  if (conflicts.length) {
    log('\nThese files have local edits, so the new version was saved beside them as .new:');
    for (const rel of conflicts) log(`  ! ${rel}  →  ${rel}.new`);
    log('Merge each one by hand and delete the .new file, or run update --force to overwrite your edits.');
  }
}

function updateConfig(root, defaultsBuf) {
  const path = join(root, CONFIG_PATH);
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [['!', `${CONFIG_PATH} isn't valid JSON, so new settings weren't added`]];
  }
  const added = mergeDefaults(config, JSON.parse(defaultsBuf.toString('utf8')));
  if (!added.length) return [];
  writeFile(root, CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  return [['~', `${CONFIG_PATH}: added ${added.join(', ')}`]];
}

function removeStaleNew(dest) {
  if (existsSync(`${dest}.new`)) unlinkSync(`${dest}.new`);
}
