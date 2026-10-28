import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGitignore, writeFile, writeManifest } from './install.js';
import {
  CliError, INSTALL_CMD, TEMPLATE_DIR, USER_FILES,
  hasCommits, packageVersion, repoRoot, sha256, templateFiles,
} from './util.js';

export function init(cwd, log = console.log) {
  const root = repoRoot(cwd);
  if (!root) {
    throw new CliError('Not inside a git repository. Run `git init`, make a first commit, then try again.');
  }
  if (!hasCommits(root)) {
    throw new CliError('This repository has no commits yet. Make a first commit, then try again.');
  }
  if (existsSync(join(root, '.claude/skills/factory'))) {
    throw new CliError(`The factory is already installed here. To refresh it, run:\n  ${INSTALL_CMD} update`);
  }

  const version = packageVersion();
  const manifest = { version, files: {} };
  const created = [];
  const kept = [];

  for (const rel of templateFiles()) {
    const content = readFileSync(join(TEMPLATE_DIR, rel));
    if (existsSync(join(root, rel))) {
      kept.push(rel);
      continue;
    }
    writeFile(root, rel, content);
    created.push(rel);
    if (!USER_FILES.has(rel)) manifest.files[rel] = sha256(content);
  }

  const ignored = ensureGitignore(root);
  writeManifest(root, manifest);

  log(`Installed the software factory v${version} in ${root}\n`);
  for (const rel of created) log(`  + ${rel}`);
  for (const rel of kept) log(`  = ${rel} (already existed, left as is)`);
  if (ignored.length) log(`  + .gitignore: ${ignored.join(', ')}`);
  log(`
Next:
  1. Open Claude Code in this repo and run:   /factory setup
  2. Commit the factory:                      git add .claude factory .gitignore && git commit -m "Add software factory"
  3. Start a job:                             /factory <feature>
  4. Watch the board:                         ${INSTALL_CMD} dashboard`);
}
