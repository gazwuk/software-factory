#!/usr/bin/env node
// Prepares a factory review round: runs config.checks once in the job's worktree and
// picks which reviewers run (and on which model) from the files the change touches.
//
//   node .claude/skills/factory/round.mjs <job-id> <round>
//
// Writes factory/jobs/<id>/round-<N>/round.md (for agents and people) and round.json
// (state the next round reads), then prints one line of JSON for the orchestrator.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAIL_LINES = 15;

// ---------- globs ----------

function globSource(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{' && glob.indexOf('}', i) > i) {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map(globSource).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

/**
 * Whether a repo-relative posix path matches a glob. `**` spans directories, `*` and
 * `?` stay within one, `{a,b}` is either. A glob with no `/` matches the file name
 * anywhere in the tree, like .gitignore.
 */
export function globMatch(glob, path) {
  const pattern = glob.replace(/^\//, '');
  const target = pattern.includes('/') ? path : basename(path);
  return new RegExp(`^${globSource(pattern)}$`).test(target);
}

const matching = (globs, files) => files.filter((f) => globs.some((g) => globMatch(g, f)));

// ---------- selection ----------

/**
 * Decides which reviewers run this round. Pure, so it can be tested without git.
 *
 * - names: the job's reviewers. config: config.reviewers.
 * - prev: the most recent earlier round.json that selected reviewers, or null.
 * - verdictOf(name, round): that reviewer's verdict in an earlier round, or null.
 * - changedSince(sha): files changed between sha and the commit under review.
 * - fullChange: files changed by the whole job, for model escalation.
 *
 * A reviewer runs when it asked for changes (or gave no verdict) last time it ran, or
 * when files in its `paths` (every file, if it has none) changed since it last passed.
 * It reviews from `since`: the commit it last passed, or the merge base if it never has.
 */
export function selectReviewers({ names, config, prev, mergeBase, verdictOf, changedSince, fullChange }) {
  const out = {};
  for (const name of names) {
    const rc = config[name] || {};
    const before = prev?.reviewers?.[name];
    let since = mergeBase;
    let lastReview = null;
    let mustRun = null;

    if (before?.run) {
      const verdict = verdictOf(name, prev.round);
      since = prev.sha;
      lastReview = `round-${prev.round}/review-${name}.md`;
      if (verdict !== 'PASS') {
        mustRun = verdict === 'CHANGES' ? `asked for changes in round ${prev.round}` : `gave no verdict in round ${prev.round}`;
      }
    } else if (before) {
      since = before.since;
      lastReview = before.lastReview;
    }

    const changed = changedSince(since);
    const touched = Array.isArray(rc.paths) ? matching(rc.paths, changed) : changed;
    const run = Boolean(mustRun) || touched.length > 0;

    let reason;
    if (mustRun) reason = mustRun;
    else if (!run) {
      reason = lastReview ? `nothing it covers changed since it passed (${lastReview})` : 'no changed files match its paths';
    } else if (!Array.isArray(rc.paths)) {
      reason = lastReview ? 'files changed since it passed' : 'reviews every change';
    } else {
      reason = `touches ${listFiles(touched)}`;
    }

    let model = rc.model || 'sonnet';
    if (run && Array.isArray(rc.escalatePaths) && rc.escalateModel) {
      const sensitive = matching(rc.escalatePaths, fullChange);
      if (sensitive.length) {
        model = rc.escalateModel;
        reason += `; ${model} because the change touches ${listFiles(sensitive)}`;
      }
    }

    out[name] = { run, model: run ? model : null, since, lastReview, reason };
  }
  return out;
}

function listFiles(files) {
  const shown = files.slice(0, 3).join(', ');
  return files.length > 3 ? `${shown} (+${files.length - 3} more)` : shown;
}

// ---------- the round ----------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
}

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

const lines = (text) => text.split('\n').filter(Boolean);

function tail(text) {
  const all = text.replace(/\s+$/, '').split('\n');
  return all.slice(-TAIL_LINES).join('\n');
}

function runChecks(checks, cwd) {
  return Object.entries(checks).map(([name, command]) => {
    const started = Date.now();
    const r = spawnSync(command, {
      cwd, shell: true, encoding: 'utf8', maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: process.env.CI || 'true' },
    });
    return {
      name, command,
      exit: r.status ?? 1,
      seconds: Math.round((Date.now() - started) / 1000),
      output: tail([r.stdout, r.stderr, r.error?.message].filter(Boolean).join('\n')),
    };
  });
}

function verdictFile(path) {
  if (!existsSync(path)) return null;
  const first = readFileSync(path, 'utf8').split('\n', 1)[0].trim();
  const m = first.match(/^VERDICT:\s*(PASS|CHANGES)\b/);
  return m ? m[1] : null;
}

function renderRound({ id, n, sha, base, mergeBase, worktree, checks, dirty, reviewers, stat }) {
  const out = [`# Round ${n} — ${id}`, ''];
  out.push(`Commit under review: \`${sha}\` on \`factory/${id}\` (base \`${base}\`, merge base \`${mergeBase}\`).`, '');

  out.push('## Checks', '');
  if (dirty) {
    out.push('Not run: the worktree has uncommitted changes. Commit everything, then the checks run again.', '', '```', dirty, '```', '');
  } else if (!checks.length) {
    out.push('No checks configured (`checks` in factory/config.json).', '');
  } else {
    const failed = checks.filter((c) => c.exit !== 0).map((c) => c.name);
    out.push(failed.length ? `**Failed:** ${failed.join(', ')}.` : 'All passed on this commit. Don\'t re-run them.', '');
    out.push('| Check | Command | Result |', '|---|---|---|');
    for (const c of checks) out.push(`| ${c.name} | \`${c.command}\` | ${c.exit === 0 ? 'passed' : `failed (exit ${c.exit})`}, ${c.seconds}s |`);
    for (const c of checks) {
      if (c.output) out.push('', `### ${c.name}`, '', '```', c.output, '```');
    }
    out.push('');
  }

  if (!reviewers) {
    out.push('## Reviewers', '', 'Not selected: the checks have to pass first.', '');
    return out.join('\n');
  }

  out.push('## Reviewers', '', '| Reviewer | Runs | Model | Why |', '|---|---|---|---|');
  for (const [name, r] of Object.entries(reviewers)) {
    out.push(`| ${name} | ${r.run ? 'yes' : 'skipped'} | ${r.model || '—'} | ${r.reason} |`);
  }
  out.push('', '## What to review', '');
  out.push(`The whole change: \`git -C ${worktree} diff ${mergeBase} ${sha}\``, '');
  for (const [name, r] of Object.entries(reviewers)) {
    if (!r.run) continue;
    if (r.since === mergeBase) out.push(`- **${name}:** first review of this change — review all of it.`);
    else out.push(`- **${name}:** since your last review (\`${r.lastReview}\`): \`git -C ${worktree} diff ${r.since} ${sha}\``);
  }
  out.push('', '## Changed files', '', '```', stat || '(none)', '```', '');
  return out.join('\n');
}

export function prepareRound(root, id, n) {
  const config = readJson(join(root, 'factory/config.json'));
  if (!config) throw new Error('factory/config.json is missing or not valid JSON');
  const base = config.baseBranch;
  const branch = `factory/${id}`;
  const worktree = join(root, '.factory-worktrees', id);
  const jobDir = join(root, 'factory/jobs', id);
  const roundDir = join(jobDir, `round-${n}`);
  if (!existsSync(worktree)) throw new Error(`worktree ${worktree} doesn't exist`);

  const sha = git(['rev-parse', branch], root);
  const mergeBase = git(['merge-base', base, branch], root);
  mkdirSync(roundDir, { recursive: true });

  const dirty = git(['status', '--porcelain'], worktree);
  const checks = dirty ? [] : runChecks(config.checks || {}, worktree);
  const failed = checks.filter((c) => c.exit !== 0).map((c) => c.name);
  const ok = !dirty && !failed.length;

  let reviewers = null;
  let stat = '';
  if (ok) {
    const job = (readJson(join(root, 'factory/board.json'))?.jobs || []).find((j) => j.id === id);
    const names = job?.reviewers || Object.keys(config.reviewers || {}).filter((k) => config.reviewers[k].enabled !== false);
    let prev = null;
    for (let k = n - 1; k >= 1 && !prev; k--) {
      const r = readJson(join(jobDir, `round-${k}`, 'round.json'));
      if (r?.reviewers) prev = r;
    }
    const changedSince = (from) => lines(git(['diff', '--name-only', '--no-renames', from, sha], root));
    reviewers = selectReviewers({
      names,
      config: config.reviewers || {},
      prev,
      mergeBase,
      verdictOf: (name, k) => verdictFile(join(jobDir, `round-${k}`, `review-${name}.md`)),
      changedSince,
      fullChange: changedSince(mergeBase),
    });
    stat = git(['diff', '--stat', mergeBase, sha], root);
  }

  const record = {
    round: n, sha, base, mergeBase,
    checks: { ok, dirty: Boolean(dirty), results: checks.map(({ output, ...c }) => c) },
    reviewers,
  };
  writeFileSync(join(roundDir, 'round.json'), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(roundDir, 'round.md'), renderRound({ id, n, sha, base, mergeBase, worktree, checks, dirty, reviewers, stat }));

  const summary = { ok, sha, roundFile: join(roundDir, 'round.md') };
  if (!ok) summary.failed = dirty ? ['uncommitted changes'] : failed;
  else {
    summary.run = Object.entries(reviewers).filter(([, r]) => r.run).map(([name, r]) => ({ name, model: r.model }));
    summary.skipped = Object.entries(reviewers).filter(([, r]) => !r.run).map(([name]) => name);
  }
  return summary;
}

function main() {
  const [id, raw] = process.argv.slice(2);
  const n = Number(raw);
  if (!id || !Number.isInteger(n) || n < 1) {
    console.error('Usage: node round.mjs <job-id> <round>');
    process.exit(2);
  }
  try {
    const root = git(['rev-parse', '--show-toplevel'], dirname(fileURLToPath(import.meta.url)));
    console.log(JSON.stringify(prepareRound(root, id, n)));
  } catch (err) {
    console.error(`round.mjs: ${(err.stderr || err.message || String(err)).toString().trim()}`);
    process.exit(1);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) main();
