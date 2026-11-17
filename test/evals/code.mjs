#!/usr/bin/env node
// Real-defect benchmark for the code reviewer. Opt-in: it runs real agents, so it
// costs tokens.
//
//   npm run eval:code-reviewer -- [--runs 3] [--models sonnet,opus]
//                                 [--cases pr9-runner-progress,...] [--out <dir>] [--keep]
//
// Each case in test/evals/code/cases.json is a commit GitHub Copilot reviewed on one of
// this repo's PRs, with the defects it found there that were confirmed and fixed
// afterwards. A run rebuilds each case as a factory job in a throwaway repo (main is
// the PR's merge base, the job branch adds the reviewed commit's change), prepares
// round 1 with the real round.mjs, runs factory-review-code through the configured
// harness, and scores the review with score.mjs. The cases' commits must be in this
// clone, so it doesn't work in a shallow one.
//
// The factory is installed in the throwaway repo but not committed, so the job's
// worktree holds only the code under review: the installed copy is newer and has the
// fixes.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../../src/init.js';
import { REPO, factory, fmt, git, preflightClaude, readJson, resultsPath, reviewRound, usd } from './common.mjs';
import { scoreReview, spread } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'code');

export const loadCases = () => readJson(join(FIXTURE, 'cases.json')).cases;

export function parseArgs(argv, cases = loadCases()) {
  const template = readJson(join(REPO, 'template/factory/config.json'));
  const opts = { runs: 3, models: [template.reviewers.code.model], cases: cases.map((c) => c.id), out: join(HERE, 'results'), keep: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--keep') { opts.keep = true; continue; }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    if (flag === '--runs') opts.runs = Number(value);
    else if (flag === '--models') opts.models = value.split(',');
    else if (flag === '--cases') opts.cases = value.split(',');
    else if (flag === '--out') opts.out = resolve(value);
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs must be a whole number of at least 1');
  const unknown = opts.cases.filter((id) => !cases.some((c) => c.id === id));
  if (unknown.length || !opts.cases.length) throw new Error(`--cases takes ids from test/evals/code/cases.json: ${cases.map((c) => c.id).join(', ')}`);
  return opts;
}

const raw = (args) => execFileSync('git', args, { cwd: REPO, maxBuffer: 256 << 20 });

/** A throwaway repo with the case's base on main and its change on the job branch, round 1 not yet prepared. */
async function buildRepo(c, model) {
  for (const sha of [c.base, c.head]) {
    try { raw(['cat-file', '-e', `${sha}^{commit}`]); } catch {
      throw new Error(`${c.id}: commit ${sha.slice(0, 8)} isn't in this clone; fetch the full history (git fetch --unshallow)`);
    }
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-eval-code-')));
  git(['init', '-q', '-b', 'main'], root);
  execFileSync('tar', ['-x', '-C', root], { input: raw(['archive', c.base]) });
  git(['add', '-A'], root);
  git(['commit', '-qm', `Before #${c.pr}`], root);

  init(root, () => {});
  const configPath = join(root, 'factory/config.json');
  const config = readJson(configPath);
  config.checks = {};
  config.worktree = { link: [], setup: '' };
  config.ui = { ...config.ui, serve: '' };
  for (const [name, r] of Object.entries(config.reviewers)) r.enabled = name === 'code';
  config.reviewers.code.model = model;
  if (process.env.FACTORY_EVAL_CLAUDE) config.runner.command = process.env.FACTORY_EVAL_CLAUDE.split(' ');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  cpSync(join(FIXTURE, 'project.md'), join(root, 'factory/project.md'));

  const id = c.id;
  const worktree = join(root, '.factory-worktrees', id);
  git(['worktree', 'add', '-q', worktree, '-b', `factory/${id}`, 'main'], root);
  const patch = raw(['diff', '--binary', c.base, c.head, '--', '.', ...c.exclude.map((p) => `:(exclude)${p}`)]);
  git(['apply', '--index', '-'], worktree, patch);
  git(['commit', '-qm', c.title], worktree);
  const { prepareWorktree } = await factory(root, 'worktree.mjs');
  const prep = prepareWorktree(root, worktree, config.worktree);
  if (!prep.ok) throw new Error(`couldn't prepare the worktree: ${prep.error}`);

  const jobDir = join(root, 'factory/jobs', id);
  mkdirSync(jobDir, { recursive: true });
  for (const f of ['request.md', 'spec.md', 'build.md']) cpSync(join(FIXTURE, 'jobs', id, f), join(jobDir, f));
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const job = {
    id, title: c.title, branch: `factory/${id}`, worktree: `.factory-worktrees/${id}`,
    stage: 'review', round: 1, roundLimit: config.maxRounds, reviewers: ['code'],
    rounds: [{ code: 'pending' }],
    decision: null, issue: null, issueUrl: null, note: null, prUrl: null, createdAt: now, updatedAt: now,
  };
  writeFileSync(join(root, 'factory/board.json'), `${JSON.stringify({ version: 1, jobs: [job] }, null, 2)}\n`);
  return { root, config, job };
}

async function runCase(c, model, keep) {
  const { root, config, job } = await buildRepo(c, model);
  try {
    const { reviews } = await reviewRound(root, config, job);
    const r = reviews.find((x) => x.name === 'code');
    if (!r) throw new Error(`${c.id}: round.mjs didn't select the code reviewer`);
    const score = scoreReview({ review: r.text, lane: 'code', fixture: c, probe: null });
    return {
      ...score, unmatched: score.blocking - score.matched,
      ok: r.ok, error: r.error, cost: r.cost, tokens: r.tokens, seconds: r.seconds, model: r.model,
      review: r.text, repo: keep ? root : null,
    };
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Mean and range across runs, per case and over all the cases, plus how often each defect was found. */
export function summarize(runs, cases) {
  const perCase = Object.fromEntries(cases.map((c) => {
    const rs = runs.map((r) => r.cases[c.id]).filter(Boolean);
    const of = (m) => spread(rs.map((r) => r[m]));
    return [c.id, { defects: c.defects.length, recall: of('recall'), blocking: of('blocking'), unmatched: of('unmatched'), cost: of('cost') }];
  }));
  const total = sum(cases.map((c) => c.defects.length));
  const found = (r) => sum(cases.map((c) => r.cases[c.id]?.found.length ?? 0));
  return {
    cases: perCase,
    defects: total,
    recall: spread(runs.map((r) => found(r) / total)),
    cost: spread(runs.map((r) => sum(cases.map((c) => r.cases[c.id]?.cost ?? 0)))),
    hits: Object.fromEntries(cases.flatMap((c) => c.defects.map((d) => [d.id, runs.filter((r) => r.cases[c.id]?.found.includes(d.id)).length]))),
  };
}

export function renderSummary(variant, runs, summary) {
  const out = [`\n${variant} — ${runs} run(s)`, ''];
  out.push('| Case | Defects | Recall | Blocking findings | Unmatched | Cost per run |');
  out.push('|---|---|---|---|---|---|');
  for (const [id, c] of Object.entries(summary.cases)) {
    out.push(`| ${id} | ${c.defects} | ${fmt(c.recall)} | ${fmt(c.blocking, false)} | ${fmt(c.unmatched, false)} | ${usd(c.cost)} |`);
  }
  out.push('', `All cases: ${fmt(summary.recall)} of ${summary.defects} defects, ${usd(summary.cost)} per run.`);
  out.push('Unmatched findings cite none of a case\'s defects: false positives, or real problems Copilot didn\'t raise. The reviews are in the results file.', '');
  const hits = Object.entries(summary.hits);
  out.push('Found (runs out of total): ' + hits.filter(([, n]) => n).map(([id, n]) => `${id} ${n}/${runs}`).join(', '));
  out.push('Never found: ' + (hits.filter(([, n]) => !n).map(([id]) => id).join(', ') || 'none'));
  return out.join('\n');
}

export async function main(argv, { log = console.log } = {}) {
  const all = loadCases();
  const opts = parseArgs(argv, all);
  const cases = all.filter((c) => opts.cases.includes(c.id));
  await preflightClaude();
  mkdirSync(opts.out, { recursive: true });

  const written = [];
  for (const model of opts.models) {
    const variant = `code-${model}`;
    const runs = [];
    for (let k = 1; k <= opts.runs; k++) {
      log(`${variant}: run ${k} of ${opts.runs} (${cases.length} case(s) in parallel)…`);
      const results = await Promise.all(cases.map((c) => runCase(c, model, opts.keep)));
      const run = { cases: Object.fromEntries(cases.map((c, i) => [c.id, results[i]])) };
      for (const [id, r] of Object.entries(run.cases)) {
        if (r.repo) log(`  kept ${r.repo}`);
        log(`  ${id}: ${r.ok ? '' : `failed (${r.error}); `}${r.verdict ?? 'no verdict'}, found ${r.found.length} of ${all.find((c) => c.id === id).defects.length}, ${r.unmatched} unmatched, $${(r.cost ?? 0).toFixed(2)}`);
      }
      runs.push(run);
    }
    const summary = summarize(runs, cases);
    const path = resultsPath(opts.out, variant);
    writeFileSync(path, `${JSON.stringify({ date: new Date().toISOString(), variant, model, runs: opts.runs, cases: opts.cases, summary, results: runs }, null, 2)}\n`);
    log(renderSummary(variant, opts.runs, summary));
    log(`\nWrote ${path}`);
    written.push(path);
  }
  return written;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`eval: ${err.message}`);
    process.exit(1);
  });
}
