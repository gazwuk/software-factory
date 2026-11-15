#!/usr/bin/env node
// Prepares a factory review round: runs config.checks once in the job's worktree and
// picks which reviewers run (and on which model) from the files the change touches.
//
//   node .claude/skills/factory/round.mjs <job-id> <round>
//
// Writes factory/jobs/<id>/round-<N>/round.md (for agents and people) and round.json
// (state the next round reads), then prints one line of JSON for the orchestrator.
// When a selected reviewer has `probe: true`, it also runs probe.mjs, whose new
// failures block the round like a failed check.
//
//   node .claude/skills/factory/round.mjs check <name> <worktree> [<base>]
//
// runs one check the way a round would, on the worktree as it is (uncommitted work
// included), and prints its result as JSON. Setup and the builder use it.
//
//   node .claude/skills/factory/round.mjs diff <worktree> <from> <to> [<path>...]
//
// prints the diff from..to with each line's number in its file beside it, so
// reviewers cite real lines.
//
//   node .claude/skills/factory/round.mjs grep <worktree> <from> <to> '<regex>'
//
// prints each line the diff from..to adds that matches a JavaScript regex, as
// `file:line: text` with the line's number in the file. Reviewers use it.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAIL_LINES = 15;
const HERE = dirname(fileURLToPath(import.meta.url));

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

// ---------- checks ----------

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * A path as a diff header prints it. Git C-quotes a path with unusual characters
 * (`"b/caf\303\251.css"`) and puts a tab after one that has a space in it.
 */
export function diffPath(s) {
  const path = s.replace(/\t$/, '');
  if (!/^".*"$/.test(path)) return path;
  const bytes = [];
  for (const [, raw, esc] of path.slice(1, -1).matchAll(/([^\\]+)|\\([0-7]{3}|.)/gs)) {
    if (raw) bytes.push(...Buffer.from(raw));
    else bytes.push(/^[0-7]{3}$/.test(esc) ? parseInt(esc, 8) : C_ESCAPES[esc] ?? esc.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The lines a `git diff -U0` adds, each as { file, line, text } with its line number
 * in the file's new version.
 */
export function addedLines(patch) {
  const out = [];
  let file = null;
  let n = 0;
  let prev = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ') && prev.startsWith('--- ')) {
      const to = diffPath(line.slice(4));
      file = to.startsWith('b/') ? to.slice(2) : null;
    } else if (file && line.startsWith('@@ ')) {
      n = Number(/^@@ -\S+ \+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (file && line.startsWith('+')) {
      out.push({ file, line: n++, text: line.slice(1) });
    }
    prev = line;
  }
  return out;
}

/** The line numbers of each file's added or changed lines, from `git diff -U0` output. */
export function parseChangedLines(patch) {
  const out = new Map();
  for (const { file, line } of addedLines(patch)) {
    if (!out.has(file)) out.set(file, new Set());
    out.get(file).add(line);
  }
  return out;
}

/**
 * The path a `diff --git a/<path> b/<path>` line names. Both halves are the same path
 * unless the file was renamed or copied, and then later lines name the paths.
 */
function gitHeaderPath(line) {
  const rest = line.slice('diff --git '.length);
  const quoted = rest.lastIndexOf(' "b/');
  if (rest.endsWith('"') && quoted >= 0) return diffPath(rest.slice(quoted + 1)).slice(2);
  return rest.slice(2, 2 + (rest.length - 5) / 2);
}

/**
 * A unified diff with each context and added line's number in the file's new version
 * in the margin (removed lines have none), under one `=== <file>` line per file. The
 * header says when a file was deleted, renamed or copied, and keeps a new file's mode
 * and mode changes, so a file with no hunks (a mode change, a pure rename, a binary
 * file) still shows, and a new executable or symlink differs from a new regular file.
 */
export function numberDiff(patch) {
  const out = [];
  let file = null;
  let n = null;
  const pad = (x) => String(x).padStart(5);
  const header = () => {
    if (!file || file.shown) return;
    file.shown = true;
    const note = file.deleted ? ' (deleted)' : file.from ? ` (${file.how} from ${file.from})` : '';
    out.push('', `=== ${file.path}${note}`, ...file.modes.map((m) => `      ${m}`));
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header();
      file = { path: gitHeaderPath(line), modes: [] };
      n = null;
    } else if (!file) {
      continue;
    } else if (n === null && /^(old|new|new file) mode /.test(line)) {
      file.modes.push(line);
    } else if (n === null && line.startsWith('deleted file mode ')) {
      file.deleted = true;
    } else if (n === null && /^(rename|copy) from /.test(line)) {
      file.how = line.startsWith('rename') ? 'renamed' : 'copied';
      file.from = diffPath(line.replace(/^\S+ from /, ''));
    } else if (n === null && /^(rename|copy) to /.test(line)) {
      file.path = diffPath(line.replace(/^\S+ to /, ''));
    } else if (line.startsWith('@@ ')) {
      header();
      n = Number(/^@@ -\S+ \+(\d+)/.exec(line)?.[1] ?? 0);
      out.push(`      ${line}`);
    } else if (n !== null && (line.startsWith(' ') || line.startsWith('+'))) {
      out.push(`${pad(n++)} ${line}`);
    } else if (n !== null && (line.startsWith('-') || line.startsWith('\\'))) {
      out.push(`      ${line}`);
    } else if (n === null && line.startsWith('Binary files')) {
      header();
      out.push(`      ${line}`);
    }
  }
  header();
  return out.join('\n').replace(/^\n/, '');
}

/** numberDiff of from..to in a worktree, optionally for some paths only. */
export function numberedDiff(worktree, from, to, paths = []) {
  const args = ['diff', '-M', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', from, to];
  return numberDiff(git(paths.length ? [...args, '--', ...paths] : args, worktree));
}

const unifiedZero = (from, to) => ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', from, ...(to ? [to] : [])];

/** The lines the diff from..to adds in a worktree that match `pattern`, as `file:line: text`. */
export function grepAdded(worktree, from, to, pattern) {
  const re = new RegExp(pattern);
  return addedLines(git(unifiedZero(from, to), worktree))
    .filter((l) => re.test(l.text))
    .map((l) => `${l.file}:${l.line}: ${l.text.trim()}`);
}

/**
 * What the work in a worktree changes compared with `base`: the files it adds or
 * changes (deleted ones left out), and each file's changed lines (`true` for an
 * untracked file, where every line is new). Uncommitted work counts, so the builder
 * can run a check before committing; a round only runs on a clean worktree.
 */
export function changeIn(cwd, base) {
  const nul = (text) => text.split('\0').filter(Boolean);
  const tracked = nul(git(['diff', '-z', '--name-only', '-M', '--diff-filter=d', base], cwd));
  const untracked = nul(git(['ls-files', '-z', '--others', '--exclude-standard'], cwd));
  const lines = parseChangedLines(git(unifiedZero(base), cwd));
  for (const f of untracked) lines.set(f, true);
  return { files: [...tracked, ...untracked], lines };
}

/**
 * Splits a linter's output into the problems on lines the change added or changed
 * and the rest. Reads two layouts: `path:line:col: message` per line (`unix`
 * formatters), and a line holding just a path followed by indented `line:col ...`
 * lines (eslint's default `stylish`, stylelint's default `string`). Returns null if
 * no line names a file in the worktree, so there's no telling which problems are new.
 */
export function splitProblems(output, cwd, lines) {
  const root = realpathSync(cwd);
  const inWorktree = (path) => {
    const abs = resolve(cwd, path);
    if (!existsSync(abs)) return null;
    const file = relative(root, realpathSync(abs)).split(sep).join('/');
    return file && !file.startsWith('..') ? file : null;
  };
  const found = { added: [], older: [] };
  const add = (file, line, text) => {
    const changed = lines.get(file);
    (changed === true || changed?.has(line) ? found.added : found.older).push(text);
  };
  let any = false;
  let current = null;
  for (const raw of output.split('\n')) {
    const text = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    const unix = text.match(/^(\S.*?):(\d+)(?::\d+)?:\s/);
    const unixFile = unix && inWorktree(unix[1]);
    if (unixFile) {
      any = true;
      add(unixFile, Number(unix[2]), text);
      continue;
    }
    const indented = current && text.match(/^\s+(\d+):\d+\s/);
    if (indented) {
      any = true;
      add(current, Number(indented[1]), `${current}:${text.trim().replace(/\s{3,}/g, '  ')}`);
    } else if (/^\S/.test(text)) {
      current = inWorktree(text);
    }
  }
  return any ? found : null;
}

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Runs one check in cwd. A check is a shell command, or a gate that sees only the
 * change: `{ command, files, scope }`. A gate's `{files}` becomes the changed files
 * matching its `files` globs (every changed file without them), and it's skipped when
 * there are none. With `scope: "lines"`, it fails only on problems on lines the change
 * added or changed, so problems already in those files don't block.
 * `change()` returns changeIn() for the work under review.
 */
export function runCheck(name, spec, cwd, change) {
  const gate = typeof spec === 'object' && spec !== null;
  const template = gate ? spec.command : spec;
  let command = template;
  if (gate) {
    const { files } = change();
    const covered = Array.isArray(spec.files) ? matching(spec.files, files) : files;
    if (!covered.length) return { name, command: template, exit: 0, seconds: 0, skipped: true, note: 'no changed files it covers', output: '' };
    command = template.replaceAll('{files}', covered.map(shellQuote).join(' '));
  }

  const started = Date.now();
  const r = spawnSync(command, {
    cwd, shell: true, encoding: 'utf8', maxBuffer: 64 << 20,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: process.env.CI || 'true' },
  });
  const result = { name, command: template, exit: r.status ?? 1, seconds: Math.round((Date.now() - started) / 1000) };
  const output = [r.stdout, r.stderr, r.error?.message].filter(Boolean).join('\n');

  if (gate && spec.scope === 'lines' && result.exit !== 0) {
    const problems = splitProblems(output, cwd, change().lines);
    if (!problems) {
      result.note = 'no file:line locations in its output, so every problem counts';
    } else if (!problems.added.length) {
      result.exit = 0;
      result.note = `${plural(problems.older.length, 'older problem')} on lines the change didn't touch`;
      return { ...result, output: '' };
    } else {
      result.note = `${plural(problems.added.length, 'problem')} on changed lines; ${problems.older.length} older ignored`;
      return { ...result, output: tail(problems.added.join('\n')) };
    }
  }
  return { ...result, output: tail(output) };
}

function runChecks(checks, cwd, base) {
  let change = null;
  const changed = () => (change ??= changeIn(cwd, base));
  return Object.entries(checks).map(([name, spec]) => runCheck(name, spec, cwd, changed));
}

/**
 * Runs one of config.checks in a worktree, as a round would, against the merge base
 * of its HEAD and `base` (config.baseBranch by default).
 */
export function tryCheck(root, name, worktree, base) {
  const config = readJson(join(root, 'factory/config.json'));
  if (!config) throw new Error('factory/config.json is missing or not valid JSON');
  const spec = config.checks?.[name];
  if (!spec) throw new Error(`config.checks has no check named "${name}"`);
  const mergeBase = git(['merge-base', base || config.baseBranch, 'HEAD'], worktree);
  let change = null;
  const result = runCheck(name, spec, worktree, () => (change ??= changeIn(worktree, mergeBase)));
  return { ok: result.exit === 0, ...result };
}

/** Runs probe.mjs as a child process and returns its summary. */
function probeProcess(root, id, n) {
  const r = spawnSync(process.execPath, [join(HERE, 'probe.mjs'), id, String(n)], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const last = (r.stdout || '').trim().split('\n').pop();
  if (r.status === 0) {
    try { return JSON.parse(last); } catch { /* fall through */ }
  }
  const error = (r.stderr || r.error?.message || `exited ${r.status}`).trim().split('\n').pop();
  return { status: 'error', reason: `probe.mjs failed: ${error}`, failures: 0, warnings: 0 };
}

function verdictFile(path) {
  if (!existsSync(path)) return null;
  const first = readFileSync(path, 'utf8').split('\n', 1)[0].trim();
  const m = first.match(/^VERDICT:\s*(PASS|CHANGES)\b/);
  return m ? m[1] : null;
}

function renderProbeSection(probe, blocks) {
  const out = ['## UI probe', ''];
  if (probe.status !== 'ran') {
    const reason = String(probe.reason || '').replace(/\.?$/, '.');
    out.push(`${probe.status === 'skipped' ? 'Skipped' : 'Not run'}: ${reason} Review from the diff.`, '');
    return out;
  }
  const failures = !probe.failures ? 'No new failures.'
    : blocks ? `**${probe.failures} new failure(s).**` : `**${probe.failures} new failure(s)**, for the reviewers to answer (they don't block this round).`;
  out.push(`${failures} ${probe.warnings} warning(s) for reviewers to judge.`, '');
  out.push(`Report: \`${probe.file}\` (screenshots in \`probe/\` beside it).`, '');
  return out;
}

function checkResult(c) {
  if (c.skipped) return `skipped: ${c.note}`;
  const result = c.exit === 0 ? 'passed' : `failed (exit ${c.exit})`;
  return `${c.note ? `${result}: ${c.note}` : result}, ${c.seconds}s`;
}

function renderRound({ id, n, sha, base, mergeBase, worktree, checks, dirty, reviewers, stat, probe, probeBlocks }) {
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
    for (const c of checks) out.push(`| ${c.name} | \`${c.command}\` | ${checkResult(c)} |`);
    for (const c of checks) {
      if (c.output) out.push('', `### ${c.name}`, '', '```', c.output, '```');
    }
    out.push('');
  }
  if (probe) out.push(...renderProbeSection(probe, probeBlocks));

  if (!reviewers) {
    out.push('## Reviewers', '', 'Not selected: the checks have to pass first.', '');
    return out.join('\n');
  }

  out.push('## Reviewers', '', '| Reviewer | Runs | Model | Why |', '|---|---|---|---|');
  for (const [name, r] of Object.entries(reviewers)) {
    out.push(`| ${name} | ${r.run ? 'yes' : 'skipped'} | ${r.model || '—'} | ${r.reason} |`);
  }
  out.push('', '## What to review', '');
  const script = join(HERE, 'round.mjs');
  out.push(`Each diff below prints every line's number in its file in the margin. Cite those numbers; don't count lines in diff output. Add file paths at the end to see only those files.`, '');
  out.push(`The whole change: \`node ${script} diff ${worktree} ${mergeBase} ${sha}\``, '');
  for (const [name, r] of Object.entries(reviewers)) {
    if (!r.run) continue;
    if (r.since === mergeBase) out.push(`- **${name}:** first review of this change — review all of it.`);
    else out.push(`- **${name}:** since your last review (\`${r.lastReview}\`): \`node ${script} diff ${worktree} ${r.since} ${sha}\``);
  }
  out.push('', `To search only the lines a diff adds: \`node ${script} grep ${worktree} <since> ${sha} '<regex>'\`, with a JavaScript regex. \`<since>\` is \`${mergeBase}\` for a first review, else the commit in your line above. It prints \`file:line: text\`.`);
  out.push('', '## Changed files', '', '```', stat || '(none)', '```', '');
  return out.join('\n');
}

/**
 * Prepares round n of a job. `probe(root, id, n)` runs the UI probe and returns its
 * summary; tests pass a stand-in. With `probeBlocks: false` (the reviewer evals), the
 * probe's failures go to the reviewers instead of blocking the round.
 */
export function prepareRound(root, id, n, { probe: runProbe = probeProcess, probeBlocks = true } = {}) {
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
  const checks = dirty ? [] : runChecks(config.checks || {}, worktree, mergeBase);
  const failed = checks.filter((c) => c.exit !== 0).map((c) => c.name);
  let ok = !dirty && !failed.length;

  let reviewers = null;
  let stat = '';
  let probe = null;
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

    if (Object.entries(reviewers).some(([name, r]) => r.run && config.reviewers?.[name]?.probe)) {
      const started = Date.now();
      probe = runProbe(root, id, n);
      if (probe.status === 'ran' && probeBlocks) {
        const output = probe.failures ? [...(probe.top || []), `Full report: ${probe.file}`].join('\n') : '';
        checks.push({
          name: 'ui-probe', command: `node .claude/skills/factory/probe.mjs ${id} ${n}`,
          exit: probe.failures ? 1 : 0, seconds: Math.round((Date.now() - started) / 1000), output,
        });
      }
      if (probe.failures && probeBlocks) {
        failed.push('ui-probe');
        ok = false;
        reviewers = null;
      }
    }
  }

  const record = {
    round: n, sha, base, mergeBase,
    checks: { ok, dirty: Boolean(dirty), results: checks.map(({ output, ...c }) => c) },
    reviewers,
    probe: probe && { status: probe.status, reason: probe.reason ?? null, failures: probe.failures, warnings: probe.warnings, file: probe.file ?? null },
  };
  writeFileSync(join(roundDir, 'round.json'), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(roundDir, 'round.md'), renderRound({ id, n, sha, base, mergeBase, worktree, checks, dirty, reviewers, stat, probe, probeBlocks }));

  const summary = { ok, sha, roundFile: join(roundDir, 'round.md') };
  if (!ok) summary.failed = dirty ? ['uncommitted changes'] : failed;
  else {
    summary.run = Object.entries(reviewers).filter(([, r]) => r.run).map(([name, r]) => ({ name, model: r.model }));
    summary.skipped = Object.entries(reviewers).filter(([, r]) => !r.run).map(([name]) => name);
  }
  return summary;
}

function main() {
  const args = process.argv.slice(2);
  let run;
  if (args[0] === 'check') {
    const [, name, worktree, base] = args;
    if (!name || !worktree) {
      console.error('Usage: node round.mjs check <name> <worktree> [<base>]');
      process.exit(2);
    }
    run = (root) => tryCheck(root, name, resolve(worktree), base);
  } else if (args[0] === 'diff') {
    const [, worktree, from, to, ...only] = args;
    if (!worktree || !from || !to) {
      console.error('Usage: node round.mjs diff <worktree> <from> <to> [<path>...]');
      process.exit(2);
    }
    try {
      const text = numberedDiff(resolve(worktree), from, to, only);
      if (text) console.log(text);
    } catch (err) {
      console.error(`round.mjs: ${(err.stderr || err.message || String(err)).toString().trim()}`);
      process.exit(1);
    }
    return;
  } else if (args[0] === 'grep') {
    const [, worktree, from, to, pattern] = args;
    if (!worktree || !from || !to || !pattern) {
      console.error("Usage: node round.mjs grep <worktree> <from> <to> '<regex>'");
      process.exit(2);
    }
    try {
      const found = grepAdded(resolve(worktree), from, to, pattern);
      if (found.length) console.log(found.join('\n'));
    } catch (err) {
      console.error(`round.mjs: ${(err.stderr || err.message || String(err)).toString().trim()}`);
      process.exit(1);
    }
    return;
  } else {
    const [id, raw] = args;
    const n = Number(raw);
    if (!id || !Number.isInteger(n) || n < 1) {
      console.error('Usage: node round.mjs <job-id> <round>');
      process.exit(2);
    }
    run = (root) => prepareRound(root, id, n);
  }
  try {
    const root = git(['rev-parse', '--show-toplevel'], dirname(fileURLToPath(import.meta.url)));
    console.log(JSON.stringify(run(root)));
  } catch (err) {
    console.error(`round.mjs: ${(err.stderr || err.message || String(err)).toString().trim()}`);
    process.exit(1);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) main();
