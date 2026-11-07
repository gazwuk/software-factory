import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError, INSTALL_CMD, repoRoot } from './util.js';

export const RUNNER_PATH = '.claude/skills/factory/runner.mjs';

/**
 * Runs `run`, `approve` or `rework` with the runner installed in this repo, so it always
 * matches the repo's skill and agents. Resolves with the exit code.
 */
export async function runner(cwd, argv) {
  const root = repoRoot(cwd);
  if (!root) throw new CliError('Not inside a git repository.');
  const path = join(root, RUNNER_PATH);
  if (!existsSync(path)) {
    throw new CliError(`This repo has no ${RUNNER_PATH}. Install or refresh the factory first:\n  ${INSTALL_CMD} init   (or update)`);
  }
  const { main } = await import(pathToFileURL(path).href);
  return main(argv, { root });
}
