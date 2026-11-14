#!/usr/bin/env node
// Seeded-defect benchmark for the UI and UX reviewers. Opt-in: it runs real agents,
// so it costs tokens.
//
//   npm run eval:reviewers -- [--runs 3] [--probe on,off] [--models sonnet,opus]
//                             [--out <dir>] [--keep]
//
// For each variant (probe on or off, times each model) it does `--runs` runs. A run
// builds a throwaway repo from test/evals/ui (a base commit, then a job branch that
// adds a feature with planted defects), installs the factory from template/, prepares
// round 1 with the real round.mjs (and so probe.mjs), runs factory-review-ui and
// factory-review-ux through the configured harness, and scores their reviews with
// score.mjs. Results go to <out>/<date>-<variant>.json, and a summary is printed.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { init } from '../../src/init.js';
import { scoreRun, spread } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const FIXTURE = join(HERE, 'ui');
const REVIEWERS = ['ui', 'ux'];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function parseArgs(argv) {
  const template = readJson(join(REPO, 'template/factory/config.json'));
  const opts = { runs: 3, probe: ['on', 'off'], models: [template.reviewers.ui.model], out: join(HERE, 'results'), keep: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--keep') { opts.keep = true; continue; }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    if (flag === '--runs') opts.runs = Number(value);
    else if (flag === '--probe') opts.probe = value.split(',');
    else if (flag === '--models') opts.models = value.split(',');
    else if (flag === '--out') opts.out = resolve(value);
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs must be a whole number of at least 1');
  if (!opts.probe.length || opts.probe.some((p) => p !== 'on' && p !== 'off')) throw new Error('--probe takes on, off or on,off');
  return opts;
}

const git = (args, cwd) => execFileSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const copy = (from, to) => cpSync(from, to, { recursive: true, filter: (src) => basename(src) !== 'node_modules' });

/** A throwaway repo with the fixture's base on main and the job's change on its branch, round 1 not yet prepared. */
async function buildRepo({ probe, model, fixture }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-eval-')));
  git(['init', '-q', '-b', 'main'], root);
  copy(join(FIXTURE, 'base'), root);
  symlinkSync(join(FIXTURE, 'base/node_modules'), join(root, 'node_modules'), 'dir');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'Shopfront home page'], root);

  init(root, () => {});
  const configPath = join(root, 'factory/config.json');
  const config = readJson(configPath);
  config.checks = {};
  config.worktree = { link: ['node_modules'], setup: '' };
  config.ui = { ...config.ui, serve: probe ? 'node serve.mjs' : '', themes: ['light'], viewports: [320, 1280] };
  for (const [name, r] of Object.entries(config.reviewers)) r.enabled = REVIEWERS.includes(name);
  for (const name of REVIEWERS) config.reviewers[name].model = model;
  if (process.env.FACTORY_EVAL_CLAUDE) config.runner.command = process.env.FACTORY_EVAL_CLAUDE.split(' ');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  cpSync(join(FIXTURE, 'job/project.md'), join(root, 'factory/project.md'));
  git(['add', '-A'], root);
  git(['commit', '-qm', 'Add the software factory'], root);

  const id = fixture.job;
  const worktree = join(root, '.factory-worktrees', id);
  git(['worktree', 'add', '-q', worktree, '-b', `factory/${id}`, 'main'], root);
  copy(join(FIXTURE, 'change'), worktree);
  git(['add', '-A'], worktree);
  git(['commit', '-qm', 'Add the Orders page'], worktree);
  const { prepareWorktree } = await factory(root, 'worktree.mjs');
  const prep = prepareWorktree(root, worktree, config.worktree);
  if (!prep.ok) throw new Error(`couldn't prepare the worktree: ${prep.error}`);

  const jobDir = join(root, 'factory/jobs', id);
  mkdirSync(jobDir, { recursive: true });
  for (const f of ['request.md', 'spec.md', 'build.md']) cpSync(join(FIXTURE, 'job', f), join(jobDir, f));
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const job = {
    id, title: 'Orders page', branch: `factory/${id}`, worktree: `.factory-worktrees/${id}`,
    stage: 'review', round: 1, roundLimit: config.maxRounds, reviewers: REVIEWERS,
    rounds: [Object.fromEntries(REVIEWERS.map((r) => [r, 'pending']))],
    decision: null, issue: null, issueUrl: null, note: null, prUrl: null, createdAt: now, updatedAt: now,
  };
  writeFileSync(join(root, 'factory/board.json'), `${JSON.stringify({ version: 1, jobs: [job] }, null, 2)}\n`);
  return { root, config, job };
}

/** A module from the throwaway repo's copy of the factory, so it works on that repo. */
const factory = (root, file) => import(pathToFileURL(join(root, '.claude/skills/factory', file)).href);

async function runOnce({ probe, model, fixture, keep }) {
  const { root, config, job } = await buildRepo({ probe, model, fixture });
  try {
    const [{ prepareRound }, { prompts, paths, agentTools }, { checkReview }, { costOf }, harness] = await Promise.all([
      factory(root, 'round.mjs'), factory(root, 'runner.mjs'), factory(root, 'probe.mjs'), factory(root, 'usage.mjs'),
      factory(root, `harness/${config.runner.harness}.mjs`),
    ]);
    const summary = prepareRound(root, job.id, 1, { probeBlocks: false });
    if (!summary.ok) throw new Error(`round 1 didn't prepare: ${summary.failed.join(', ')}`);
    const p = paths(root, job);
    const roundDir = p.round(1);
    const round = readJson(join(roundDir, 'round.json'));
    if (probe && round.probe?.status !== 'ran') throw new Error(`the probe didn't run: ${round.probe?.reason ?? 'no reviewer selected it'}`);

    const reviews = await Promise.all(summary.run.map(async ({ name, model: m }) => {
      const agent = `review-${name}`;
      const res = await harness.runAgent({
        root, agent, model: m, prompt: prompts.reviewer(p, job, config.baseBranch, name, 1),
        tools: agentTools(root, agent), options: config.runner,
      });
      const file = join(roundDir, `review-${name}.md`);
      return {
        name, model: m, ok: res.ok, error: res.error,
        text: existsSync(file) ? readFileSync(file, 'utf8') : '',
        checkReview: checkReview(root, job.id, 1, name).ok,
        cost: costOf(res.usage.models, config.pricing).costUsd,
        tokens: Object.values(res.usage.models).reduce((n, t) => n + t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h, 0),
        seconds: res.usage.activeSeconds,
      };
    }));
    const probeJson = round.probe?.status === 'ran' ? readJson(join(roundDir, 'probe.json')) : null;
    const score = scoreRun({ reviews: Object.fromEntries(reviews.map((r) => [r.name, r.text])), fixture, probe: probeJson });
    for (const r of reviews) Object.assign(score.reviewers[r.name], { ok: r.ok, error: r.error, checkReview: r.checkReview, cost: r.cost, tokens: r.tokens, seconds: r.seconds, model: r.model });
    return { ...score, reviews: Object.fromEntries(reviews.map((r) => [r.name, r.text])), repo: keep ? root : null };
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

const METRICS = ['recall', 'precision', 'falsePositives', 'cost', 'tokens'];

/** Mean and range of each metric across runs, per reviewer, plus the combined and probe recall. */
export function summarize(runs, fixture) {
  const reviewers = {};
  for (const name of REVIEWERS) {
    const rs = runs.map((r) => r.reviewers[name]).filter(Boolean);
    reviewers[name] = Object.fromEntries(METRICS.map((m) => [m, spread(rs.map((r) => r[m]))]));
    reviewers[name].checkReview = `${rs.filter((r) => r.checkReview).length}/${rs.length}`;
  }
  const hits = Object.fromEntries(fixture.defects.map((d) => [d.id, runs.filter((r) => r.combined.found.includes(d.id)).length]));
  return {
    reviewers,
    combined: spread(runs.map((r) => r.combined.recall)),
    probe: spread(runs.map((r) => r.probe.recall)),
    defects: hits,
  };
}

const fmt = (s, pct = true) => {
  if (!s) return '—';
  const f = (x) => (pct ? `${Math.round(x * 100)}%` : Number.isInteger(x) ? String(x) : x.toFixed(2));
  return s.min === s.max ? f(s.mean) : `${f(s.mean)} (${f(s.min)}–${f(s.max)})`;
};
const usd = (s) => (s ? `$${s.mean.toFixed(2)}${s.min === s.max ? '' : ` ($${s.min.toFixed(2)}–$${s.max.toFixed(2)})`}` : '—');

export function renderSummary(variant, runs, summary, fixture) {
  const out = [`\n${variant} — ${runs} run(s)`, ''];
  out.push('| Reviewer | Recall (own lane) | Precision | False positives on controls | check-review | Cost per run |');
  out.push('|---|---|---|---|---|---|');
  for (const [name, r] of Object.entries(summary.reviewers)) {
    out.push(`| ${name} | ${fmt(r.recall)} | ${fmt(r.precision)} | ${fmt(r.falsePositives, false)} | ${r.checkReview} | ${usd(r.cost)} |`);
  }
  out.push('', `Both reviewers: ${fmt(summary.combined)} of ${fixture.defects.length} defects. Probe items alone point at ${fmt(summary.probe)}.`, '');
  out.push('Found (runs out of total): ' + fixture.defects.map((d) => `${d.id} ${summary.defects[d.id]}/${runs}`).join(', '));
  return out.join('\n');
}

function resultsPath(dir, variant) {
  const date = new Date().toISOString().slice(0, 10);
  for (let k = 1; ; k++) {
    const path = join(dir, `${date}-${variant}${k > 1 ? `-${k}` : ''}.json`);
    if (!existsSync(path)) return path;
  }
}

export async function main(argv, { log = console.log } = {}) {
  const opts = parseArgs(argv);
  const fixture = readJson(join(FIXTURE, 'defects.json'));
  if (!existsSync(join(FIXTURE, 'base/node_modules/playwright')) && opts.probe.includes('on')) {
    throw new Error('the fixture\'s Playwright and axe-core aren\'t installed: run `npm ci --prefix test/evals/ui/base`, then `npx --prefix test/evals/ui/base playwright install chromium`');
  }
  const { preflight } = await import(pathToFileURL(join(REPO, 'template/.claude/skills/factory/harness/claude-code.mjs')).href);
  const command = process.env.FACTORY_EVAL_CLAUDE?.split(' ');
  const why = preflight({ command });
  if (why) throw new Error(why);
  mkdirSync(opts.out, { recursive: true });

  const written = [];
  for (const model of opts.models) {
    for (const probe of opts.probe) {
      const variant = `probe-${probe}-${model}`;
      const runs = [];
      for (let k = 1; k <= opts.runs; k++) {
        log(`${variant}: run ${k} of ${opts.runs}…`);
        const run = await runOnce({ probe: probe === 'on', model, fixture, keep: opts.keep });
        if (run.repo) log(`  kept ${run.repo}`);
        for (const [name, r] of Object.entries(run.reviewers)) {
          log(`  ${name}: ${r.ok ? '' : `failed (${r.error}); `}recall ${r.recall == null ? '—' : `${Math.round(r.recall * 100)}%`}, ${r.matched}/${r.blocking} blocking findings matched, $${(r.cost ?? 0).toFixed(2)}`);
        }
        runs.push(run);
      }
      const summary = summarize(runs, fixture);
      const path = resultsPath(opts.out, variant);
      writeFileSync(path, `${JSON.stringify({ date: new Date().toISOString(), variant, probe, model, runs: opts.runs, summary, results: runs }, null, 2)}\n`);
      log(renderSummary(variant, opts.runs, summary, fixture));
      log(`\nWrote ${path}`);
      written.push(path);
    }
  }
  return written;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`eval: ${err.message}`);
    process.exit(1);
  });
}
