// What the reviewer benchmarks share: run.mjs (the UI and UX reviewers on a planted
// fixture) and code.mjs (the code reviewer on real defects from this repo's history).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export const git = (args, cwd, input) => execFileSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.com', ...args], {
  cwd, input, stdio: 'pipe', maxBuffer: 256 << 20,
}).toString().trim();

/** A module from the throwaway repo's copy of the factory, so it works on that repo. */
export const factory = (root, file) => import(pathToFileURL(join(root, '.claude/skills/factory', file)).href);

/** Throws when the configured claude can't run agents (FACTORY_EVAL_CLAUDE overrides it). */
export async function preflightClaude() {
  const { preflight } = await import(pathToFileURL(join(REPO, 'template/.claude/skills/factory/harness/claude-code.mjs')).href);
  const why = preflight({ command: process.env.FACTORY_EVAL_CLAUDE?.split(' ') });
  if (why) throw new Error(why);
}

/**
 * Prepares round 1 of `job` with the throwaway repo's round.mjs and runs every reviewer
 * it selects, in parallel, through the configured harness. Returns round.json, the
 * round folder, and each review's text, cost and whether check-review accepts it.
 */
export async function reviewRound(root, config, job) {
  const [{ prepareRound }, { prompts, paths, agentTools }, { checkReview }, { costOf }, harness] = await Promise.all([
    factory(root, 'round.mjs'), factory(root, 'runner.mjs'), factory(root, 'probe.mjs'), factory(root, 'usage.mjs'),
    factory(root, `harness/${config.runner.harness}.mjs`),
  ]);
  const summary = prepareRound(root, job.id, 1, { probeBlocks: false });
  if (!summary.ok) throw new Error(`round 1 didn't prepare: ${summary.failed.join(', ')}`);
  const p = paths(root, job);
  const roundDir = p.round(1);
  const round = readJson(join(roundDir, 'round.json'));
  const reviews = await Promise.all(summary.run.map(async ({ name, model }) => {
    const agent = `review-${name}`;
    const res = await harness.runAgent({
      root, agent, model, prompt: prompts.reviewer(p, job, config.baseBranch, name, 1),
      tools: agentTools(root, agent), options: config.runner,
    });
    const file = join(roundDir, `review-${name}.md`);
    return {
      name, model, ok: res.ok, error: res.error,
      text: existsSync(file) ? readFileSync(file, 'utf8') : '',
      checkReview: checkReview(root, job.id, 1, name).ok,
      cost: costOf(res.usage.models, config.pricing).costUsd,
      tokens: Object.values(res.usage.models).reduce((n, t) => n + t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h, 0),
      seconds: res.usage.activeSeconds,
    };
  }));
  return { round, roundDir, reviews };
}

/** <dir>/<date>-<variant>.json, numbered when that exists already. */
export function resultsPath(dir, variant) {
  const date = new Date().toISOString().slice(0, 10);
  for (let k = 1; ; k++) {
    const path = join(dir, `${date}-${variant}${k > 1 ? `-${k}` : ''}.json`);
    if (!existsSync(path)) return path;
  }
}

/** A spread() as "mean (min–max)", in percent unless `pct` is false. */
export const fmt = (s, pct = true) => {
  if (!s) return '—';
  const f = (x) => (pct ? `${Math.round(x * 100)}%` : Number.isInteger(x) ? String(x) : x.toFixed(2));
  return s.min === s.max ? f(s.mean) : `${f(s.mean)} (${f(s.min)}–${f(s.max)})`;
};
export const usd = (s) => (s ? `$${s.mean.toFixed(2)}${s.min === s.max ? '' : ` ($${s.min.toFixed(2)}–$${s.max.toFixed(2)})`}` : '—');
