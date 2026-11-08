import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentTools, nextAction, paths, prBody, prompts, reconcile } from '../template/.claude/skills/factory/runner.mjs';
import { lockPath, tryLock, unlock } from '../template/.claude/skills/factory/board.mjs';
import { describe, preflight } from '../template/.claude/skills/factory/harness/claude-code.mjs';
import { jobOf, roundOf } from '../template/.claude/skills/factory/usage.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../template', import.meta.url));
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// ---------- nextAction ----------

const facts = (over = {}) => ({
  spec: false, worktree: true, head: 'h1', ahead: 0, build: false, responded: false, human: false,
  round: null, reviews: {}, decision: null, reason: null, ...over,
});
const job = (over = {}) => ({ id: '001-x', stage: 'spec', round: 0, roundLimit: 2, reviewers: ['code', 'ui'], ...over });
const roundJson = (n, { ok = true, sha = 'h1', run = { code: 'sonnet' }, failed = [] } = {}) => ({
  round: n, sha,
  checks: { ok, dirty: false, results: [{ name: 'test', exit: failed.includes('test') ? 1 : 0 }] },
  reviewers: ok ? { code: { run: 'code' in run, model: run.code || null }, ui: { run: false, model: null } } : null,
});

test('nextAction: spec and build stages', () => {
  assert.deepEqual(nextAction(job(), facts()), { type: 'spec' });
  assert.deepEqual(nextAction(job(), facts({ spec: true })), { type: 'worktree' });
  assert.deepEqual(nextAction(job({ stage: 'build' }), facts({ worktree: false })), { type: 'worktree' });
  assert.deepEqual(nextAction(job({ stage: 'build' }), facts()), { type: 'build', step: 'first' });
  assert.deepEqual(nextAction(job({ stage: 'build' }), facts({ build: true })), { type: 'build', step: 'first' }, 'no commits yet');
  assert.deepEqual(nextAction(job({ stage: 'build' }), facts({ build: true, ahead: 2 })), { type: 'round', n: 1 });
  assert.deepEqual(nextAction(job({ stage: 'build', round: 1 }), facts({ build: true, ahead: 2 })), { type: 'build', step: 'review' });
  assert.deepEqual(nextAction(job({ stage: 'build', round: 1 }), facts({ build: true, responded: true })), { type: 'round', n: 2 });
  assert.deepEqual(nextAction(job({ stage: 'build', round: 1 }), facts({ build: true, human: true })), { type: 'build', step: 'rework' });
  assert.deepEqual(nextAction(job({ stage: 'build', round: 0 }), facts({ build: true, ahead: 1, human: true })), { type: 'build', step: 'rework' });
  assert.deepEqual(nextAction(job({ stage: 'build', round: 0 }), facts({ build: true, ahead: 1, human: true, responded: true })), { type: 'round', n: 1 });
});

test('nextAction: checks, check fixes and their limit', () => {
  const review = (over) => job({ stage: 'review', round: 1, ...over });
  assert.deepEqual(nextAction(review(), facts()), { type: 'checks', n: 1 });
  assert.deepEqual(nextAction(review(), facts({ round: roundJson(1, { ok: false, failed: ['test'] }) })), { type: 'build', step: 'checkfix' });
  assert.deepEqual(nextAction(review(), facts({ head: 'h2', round: roundJson(1, { ok: false }) })), { type: 'checks', n: 1 }, 'fixed since');
  assert.deepEqual(nextAction(review({ runner: { checkFixes: { 1: 2 } } }), facts({ round: roundJson(1, { ok: false, failed: ['test'] }) })),
    { type: 'needs-human', note: 'checks still failing: test' });
});

test('nextAction: reviews, rounds and approval', () => {
  const review = (over) => job({ stage: 'review', round: 1, ...over });
  const r1 = roundJson(1);
  assert.deepEqual(nextAction(review(), facts({ round: r1 })), { type: 'review', n: 1, reviewers: [{ name: 'code', model: 'sonnet' }] });
  assert.deepEqual(nextAction(review(), facts({ round: r1, reviews: { code: 'PASS' } })), { type: 'stage', stage: 'approval' });
  assert.deepEqual(nextAction(review(), facts({ round: r1, reviews: { code: 'CHANGES' } })), { type: 'stage', stage: 'build' });
  assert.deepEqual(nextAction(review({ round: 2 }), facts({ round: roundJson(2), reviews: { code: 'CHANGES' } })),
    { type: 'needs-human', note: 'still CHANGES after 2 rounds: code' });
  assert.deepEqual(nextAction(review(), facts({ round: roundJson(1, { run: {} }) })), { type: 'stage', stage: 'approval' }, 'nobody to run');

  const approval = job({ stage: 'approval', round: 1 });
  assert.deepEqual(nextAction(approval, facts()), { type: 'approver' });
  assert.deepEqual(nextAction(approval, facts({ decision: 'APPROVE' })), { type: 'ship' });
  assert.deepEqual(nextAction(approval, facts({ decision: 'ESCALATE', reason: 'touches auth' })),
    { type: 'needs-human', note: 'touches auth', decision: 'ESCALATE' });
  for (const stage of ['needs-human', 'merged', 'pr-open', 'failed']) assert.equal(nextAction(job({ stage }), facts()), null);
});

// ---------- prompts and agents ----------

test('prompts carry the paths usage.mjs reads the job and round from', () => {
  const j = job({ title: 'X', round: 2 });
  const p = paths('/repo', j);
  const first = prompts.builder(p, { ...j, round: 0 }, 'main', 'first', false);
  assert.equal(jobOf(first), '001-x');
  assert.equal(roundOf(first, 'factory-builder'), null);
  assert.match(first, /Build notes \(you write this\): \/repo\/factory\/jobs\/001-x\/build\.md/);
  for (const step of ['checkfix', 'review', 'rework']) {
    assert.equal(roundOf(prompts.builder(p, j, 'main', step, true), 'factory-builder'), 2, step);
  }
  assert.match(prompts.builder(p, j, 'main', 'review', true), /append a `## Round 2 response` section/);
  const review = prompts.reviewer(p, j, 'main', 'code', 2);
  assert.equal(roundOf(review, 'factory-review-code'), 2);
  assert.match(review, /Output: \/repo\/factory\/jobs\/001-x\/round-2\/review-code\.md/);
  assert.match(prompts.approver(p, j, 'main'), /Final round file: \/repo\/factory\/jobs\/001-x\/round-2\/round\.md/);
});

test('agentTools reads the tools line of an agent definition', () => {
  assert.deepEqual(agentTools(TEMPLATE, 'builder'), ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit']);
  assert.deepEqual(agentTools(TEMPLATE, 'review-code'), ['Read', 'Grep', 'Glob', 'Bash', 'Write']);
  assert.deepEqual(agentTools(TEMPLATE, 'missing'), []);
});

test('prBody has the goal, criteria, latest verdicts and the closing keyword', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-pr-'));
  temps.push(root);
  const j = job({ title: 'X', issue: 7, reviewers: ['code', 'ui'], rounds: [{ code: 'CHANGES', ui: 'SKIPPED' }, { code: 'PASS', ui: 'SKIPPED' }] });
  execFileSync('mkdir', ['-p', paths(root, j).jobDir]);
  writeFileSync(paths(root, j).spec, '# X\n\n## Goal\nMake X.\n\n## Scope\n- s\n\n## Acceptance criteria\n1. X works.\n');
  const body = prBody(root, j, 'APPROVE: fine');
  assert.match(body, /## Goal\n\nMake X\.\n\n## Acceptance criteria\n\n1\. X works\.\n/);
  assert.match(body, /- code: PASS\n- ui: skipped/);
  assert.match(body, /\*\*Approval:\*\* APPROVE: fine\n\nCloses #7\n$/);
});

test('preflight checks the claude command supports the flags the runner passes', () => {
  assert.equal(preflight({ command: [process.execPath, FAKE] }), null);
  const dir = mkdtempSync(join(tmpdir(), 'factory-old-'));
  temps.push(dir);
  writeFileSync(join(dir, 'old.mjs'), "console.log('  --agents <json>\\n  --output-format <format>\\n  --permission-mode <mode> (choices: default, plan)')");
  assert.equal(preflight({ command: [process.execPath, join(dir, 'old.mjs')] }),
    `${process.execPath} ${join(dir, 'old.mjs')} doesn't support --agent, stream-json, --verbose, --allowedTools, dontAsk. Update Claude Code (\`claude update\`).`);
  assert.match(preflight({ command: '/nonexistent/claude' }), /--help` failed \(ENOENT\)/);
});

test('describe turns a tool call into one short line', () => {
  assert.equal(describe('Bash', { command: 'npm test -- --watch=false\necho done', description: 'Run tests' }), '$ npm test -- --watch=false');
  assert.equal(describe('Edit', { file_path: '/repo/src/app.js', old_string: 'a' }), 'Edit /repo/src/app.js');
  assert.equal(describe('Grep', { pattern: 'TODO', path: 'src' }), 'Grep TODO');
  assert.equal(describe('TodoWrite', { todos: [] }), 'TodoWrite');
});

// ---------- end to end, with a fake claude ----------

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
};

function factoryRepo({ items = ['Add alpha', 'Add beta'], config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-run-'));
  temps.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: ENV });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  execFileSync(process.execPath, [CLI, 'init'], { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'factory/project.md'), '# Project profile\n\nA test repo.\n');
  const cfg = JSON.parse(readFileSync(join(dir, 'factory/config.json'), 'utf8'));
  Object.assign(cfg, { checks: { test: 'true' } }, config);
  cfg.runner = { ...cfg.runner, command: [process.execPath, FAKE], ...config.runner };
  writeFileSync(join(dir, 'factory/config.json'), JSON.stringify(cfg, null, 2));
  writeFileSync(join(dir, 'factory/backlog.md'), `# Backlog\n\n${items.map((i) => `- [ ] ${i}\n  Details: for ${i}.\n`).join('')}`);
  git('add', '-A');
  git('commit', '-qm', 'install the factory');
  return dir;
}

function start(dir, args, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...ENV, FAKE_LOG: join(dir, 'fake.log'), ...env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exit = new Promise((done) => child.on('close', (code) => done({ code, out })));
  return { child, exit };
}

const runCli = (dir, args, env) => start(dir, args, env).exit;
const board = (dir) => JSON.parse(readFileSync(join(dir, 'factory/board.json'), 'utf8'));
const log = (dir) => readFileSync(join(dir, 'fake.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const gitOut = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

async function until(check, ms = 20_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

test('run --parallel 2 takes two backlog items to merge, writing the usual job files', async () => {
  const dir = factoryRepo();
  const { code, out } = await runCli(dir, ['run', '--parallel', '2']);
  assert.equal(code, 0, out);

  const jobs = board(dir).jobs;
  assert.deepEqual(jobs.map((j) => [j.id, j.stage, j.round, j.decision]),
    [['001-add-alpha', 'merged', 1, 'APPROVE'], ['002-add-beta', 'merged', 1, 'APPROVE']]);
  assert.deepEqual(jobs[0].rounds, [{ security: 'PASS', ux: 'SKIPPED', ui: 'SKIPPED', code: 'PASS' }]);

  // Both started before either finished.
  assert.deepEqual(log(dir).slice(0, 2).map((l) => l.agent), ['spec-writer', 'spec-writer']);

  const history = gitOut(dir, 'log', '--format=%s', 'main');
  for (const j of jobs) {
    assert.match(history, new RegExp(`factory: merge ${j.id} — ${j.title}`));
    assert.match(history, new RegExp(`factory: record job ${j.id}`));
    const tracked = gitOut(dir, 'ls-files', `factory/jobs/${j.id}`).split('\n');
    for (const f of ['request.md', 'spec.md', 'build.md', 'decision.md', 'round-1/round.md', 'round-1/round.json',
      'round-1/review-code.md', 'round-1/review-security.md']) {
      assert.ok(tracked.includes(`factory/jobs/${j.id}/${f}`), `${j.id}/${f}`);
    }
    assert.equal(readdirSync(join(dir, 'factory/jobs', j.id, 'usage')).length, 5, 'spec-writer, builder, 2 reviewers, approver');
    assert.ok(existsSync(join(dir, `${j.id}.txt`)), 'the change is merged into the main checkout');
    assert.ok(!existsSync(join(dir, '.factory-worktrees', j.id)));
    assert.equal(gitOut(dir, 'branch', '--list', `factory/${j.id}`), '');
  }
  assert.equal(readFileSync(join(dir, 'factory/jobs/001-add-alpha/request.md'), 'utf8'), 'Add alpha\nDetails: for Add alpha.\n');
  assert.match(readFileSync(join(dir, 'factory/backlog.md'), 'utf8'), /- \[x\] Add alpha \(job 001-add-alpha\)\n.*\n- \[x\] Add beta \(job 002-add-beta\)/);

  const usage = JSON.parse(readFileSync(join(dir, 'factory/usage.json'), 'utf8'));
  assert.deepEqual(Object.keys(usage.jobs).sort(), ['001-add-alpha', '002-add-beta']);
  assert.ok(usage.jobs['001-add-alpha'].costUsd > 0);

  // Each agent got exactly its own tools, without prompts.
  const builder = log(dir).find((l) => l.agent === 'builder');
  assert.equal(builder.model, 'opus');
  assert.deepEqual(builder.args.slice(builder.args.indexOf('--permission-mode'), builder.args.indexOf('--permission-mode') + 4),
    ['--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Glob,Bash,Write,Edit']);
  assert.ok(!existsSync(join(dir, 'factory/.locks/runner')), 'locks are released');

  // Progress shows as it happens, with paths relative to the repo.
  assert.match(out, /\[001-add-alpha\] round 1: running checks \(test\)/);
  assert.match(out, /\[001-add-alpha\] builder: Read factory\/jobs\/001-add-alpha\/spec\.md/);
  assert.match(out, /\[001-add-alpha\] builder finished in \d+s: done/);
  assert.deepEqual(readdirSync(join(dir, 'factory/activity')), [], 'nothing is left showing as running');
});

test('a killed runner resumes jobs from their files', async () => {
  const dir = factoryRepo({ items: ['Add gamma'] });
  const marker = join(dir, 'hung');
  const first = start(dir, ['run'], { FAKE_BUILDER_HANG: marker });
  await until(() => existsSync(marker));
  const running = join(dir, 'factory/activity/001-add-gamma.json');
  await until(() => existsSync(running));
  const now = JSON.parse(readFileSync(running, 'utf8'));
  assert.equal(now.pid, first.child.pid);
  assert.deepEqual(now.steps.map((s) => [s.name, s.model]), [['builder', 'opus']]);
  first.child.kill('SIGTERM');
  const stopped = await first.exit;
  assert.equal(stopped.code, 130, stopped.out);
  assert.equal(board(dir).jobs[0].stage, 'build');

  const { code, out } = await runCli(dir, ['run'], { FAKE_BUILDER_HANG: marker });
  assert.equal(code, 0, out);
  assert.match(out, /\[001-add-gamma\] resuming at stage build/);
  assert.equal(board(dir).jobs[0].stage, 'merged');
  const agents = log(dir).map((l) => l.agent);
  assert.deepEqual(agents.slice(0, 3), ['spec-writer', 'builder', 'builder'], 'the spec was not redone; the killed build was');
  assert.deepEqual(agents.slice(3).sort(), ['approver', 'review-code', 'review-security']);
  assert.equal(readdirSync(join(dir, 'factory/jobs/001-add-gamma/usage')).length, 5, 'the killed builder left no record');
});

test('a review asking for changes gets a second round on the fix model', async () => {
  const dir = factoryRepo({ items: ['Add delta'] });
  const { code, out } = await runCli(dir, ['run'], { FAKE_CHANGES_ONCE: join(dir, 'changed') });
  assert.equal(code, 0, out);
  const [j] = board(dir).jobs;
  assert.equal(j.stage, 'merged');
  assert.deepEqual(j.rounds, [
    { security: 'PASS', ux: 'SKIPPED', ui: 'SKIPPED', code: 'CHANGES' },
    { security: 'PASS', ux: 'SKIPPED', ui: 'SKIPPED', code: 'PASS' },
  ]);
  const builders = log(dir).filter((l) => l.agent === 'builder');
  assert.deepEqual(builders.map((b) => b.model), ['opus', 'sonnet']);
  assert.match(readFileSync(join(dir, 'factory/jobs/001-add-delta/build.md'), 'utf8'), /## Round 1 response/);
});

test('needs-human jobs can be reworked or approved from the CLI', async () => {
  const dir = factoryRepo({ items: ['Add epsilon'], config: { maxRounds: 1 } });
  let r = await runCli(dir, ['run'], { FAKE_CHANGES_ONCE: join(dir, 'changed') });
  assert.equal(r.code, 0, r.out);
  let [j] = board(dir).jobs;
  assert.deepEqual([j.stage, j.note], ['needs-human', 'still CHANGES after 1 rounds: code']);

  r = await runCli(dir, ['approve', '001-add-epsilon']);
  assert.equal(r.code, 0, r.out);
  assert.equal(board(dir).jobs[0].stage, 'merged', 'approve ships without the approver');
  assert.equal(log(dir).filter((l) => l.agent === 'approver').length, 0);

  const dir2 = factoryRepo({ items: ['Add zeta'], config: { maxRounds: 1 } });
  await runCli(dir2, ['run'], { FAKE_CHANGES_ONCE: join(dir2, 'changed') });
  r = await runCli(dir2, ['rework', '001-add-zeta', 'Please', 'fix', 'it']);
  assert.equal(r.code, 0, r.out);
  [j] = board(dir2).jobs;
  assert.deepEqual([j.stage, j.round, j.roundLimit], ['merged', 2, 2]);
  assert.equal(readFileSync(join(dir2, 'factory/jobs/001-add-zeta/round-1/human.md'), 'utf8'), '# Human feedback\n\nPlease fix it\n');
  assert.equal(log(dir2).filter((l) => l.agent === 'builder').at(1).model, 'opus', 'rework uses the full builder model');

  r = await runCli(dir2, ['approve', '001-add-zeta']);
  assert.equal(r.code, 1);
  assert.match(r.out, /is merged; only a needs-human job can be approved/);
});

test('run refuses an unconfigured repo and a second runner', async () => {
  const dir = factoryRepo({ items: [] });
  writeFileSync(join(dir, 'factory/project.md'), '<!-- factory:unconfigured -->\n');
  let r = await runCli(dir, ['run']);
  assert.equal(r.code, 1);
  assert.match(r.out, /run \/factory setup/);

  execFileSync('mkdir', ['-p', join(dir, 'factory/.locks/runner')]);
  writeFileSync(join(dir, 'factory/.locks/runner/pid'), String(process.pid));
  r = await runCli(dir, ['run']);
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`already running in this repo \\(pid ${process.pid}\\)`));
});

// ---------- recovery (PR #8 review) ----------

const setBoard = (dir, edit) => {
  const b = board(dir);
  edit(b.jobs);
  writeFileSync(join(dir, 'factory/board.json'), JSON.stringify(b, null, 2));
};

test('reconcile restores verdicts written to files but not to the board', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-rec-'));
  temps.push(root);
  execFileSync('mkdir', ['-p', join(root, 'factory')]);
  const j = job({ stage: 'review', round: 1, rounds: [{ code: 'pending', ui: 'pending' }] });
  writeFileSync(join(root, 'factory/board.json'), JSON.stringify({ version: 1, jobs: [j] }));
  const after = reconcile({ root }, j, facts({ round: roundJson(1), reviews: { code: 'PASS' } }));
  assert.deepEqual(after.rounds, [{ code: 'PASS', ui: 'SKIPPED' }]);
  assert.equal(reconcile({ root }, after, facts({ round: roundJson(1), reviews: { code: 'PASS' } })), after, 'no write when in step');
});

test('run --job rejects a missing job id instead of running the whole queue', async () => {
  const dir = factoryRepo({ items: ['Add eta'] });
  for (const args of [['run', '--job'], ['run', '--job='], ['run', '--job', '--parallel', '2']]) {
    const r = await runCli(dir, args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.out, /--job takes a job id/);
  }
  assert.ok(!existsSync(join(dir, 'fake.log')), 'nothing ran');
});

test('a ship that stopped after merging carries on, and a failed record commit can be retried', async () => {
  const dir = factoryRepo({ items: ['Add theta'], config: { maxRounds: 1 } });
  await runCli(dir, ['run'], { FAKE_CHANGES_ONCE: join(dir, 'changed') });
  const id = '001-add-theta';
  // As if a ship merged and deleted the branch, then stopped.
  execFileSync('git', ['merge', '-q', '--no-ff', `factory/${id}`, '-m', 'merged'], { cwd: dir, env: ENV });
  execFileSync('git', ['worktree', 'remove', `.factory-worktrees/${id}`], { cwd: dir });
  execFileSync('git', ['branch', '-d', `factory/${id}`], { cwd: dir });
  setBoard(dir, ([j]) => { j.runner = { ...j.runner, merged: 'abc1234' }; });

  // A pre-commit hook that rejects the record commit.
  const hook = join(dir, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "no thanks" >&2\nexit 1\n', { mode: 0o755 });
  let r = await runCli(dir, ['approve', id]);
  let [j] = board(dir).jobs;
  assert.equal(j.stage, 'needs-human', r.out);
  assert.match(j.note, /^merged as abc1234, but committing factory\/jobs\/001-add-theta failed: no thanks/);

  rmSync(hook);
  r = await runCli(dir, ['approve', id]);
  assert.equal(r.code, 0, r.out);
  [j] = board(dir).jobs;
  assert.equal(j.stage, 'merged');
  assert.match(gitOut(dir, 'log', '-1', '--format=%s'), /factory: record job 001-add-theta/);
  assert.equal(gitOut(dir, 'log', '--format=%s').split('\n').filter((l) => l === 'merged').length, 1, 'not merged twice');
});

test('a backlog item claimed just before a crash is ticked for its job, not started twice', async () => {
  const dir = factoryRepo({ items: ['Add iota', 'Add kappa'] });
  // As if the runner created the job for "Add iota" and stopped before ticking it.
  execFileSync('mkdir', ['-p', join(dir, 'factory/jobs/001-add-iota')]);
  writeFileSync(join(dir, 'factory/jobs/001-add-iota/request.md'), 'Add iota\nDetails: for Add iota.\n');
  writeFileSync(join(dir, 'factory/board.json'), JSON.stringify({ version: 1, jobs: [{
    id: '001-add-iota', title: 'Add iota', stage: 'spec', round: 0, roundLimit: 2,
    reviewers: ['security', 'ux', 'ui', 'code'], rounds: [], decision: null, issue: null, note: null, pendingBacklogItem: 'Add iota',
  }] }));
  const r = await runCli(dir, ['run']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(board(dir).jobs.map((j) => [j.id, j.stage, j.pendingBacklogItem]),
    [['001-add-iota', 'merged', undefined], ['002-add-kappa', 'merged', undefined]]);
  assert.match(readFileSync(join(dir, 'factory/backlog.md'), 'utf8'), /- \[x\] Add iota \(job 001-add-iota\)[\s\S]*- \[x\] Add kappa \(job 002-add-kappa\)/);
});

test('agents a crashed runner left running are stopped before the job is picked up', async () => {
  const dir = factoryRepo({ items: ['Add lambda'] });
  const marker = join(dir, 'hung');
  const first = start(dir, ['run'], { FAKE_BUILDER_HANG: marker });
  await until(() => existsSync(marker));
  first.child.kill('SIGKILL'); // a crash: the hung builder survives
  await first.exit;
  const orphan = Number(readFileSync(`${lockPath(dir, 'job-001-add-lambda')}.agents`, 'utf8'));
  assert.doesNotThrow(() => process.kill(orphan, 0), 'the builder outlived the runner');

  const { code, out } = await runCli(dir, ['run'], { FAKE_BUILDER_HANG: marker });
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`stopping agent process ${orphan}`));
  assert.throws(() => process.kill(orphan, 0));
  assert.equal(board(dir).jobs[0].stage, 'merged');
});

test('approve and rework refuse a job another process holds', async () => {
  const dir = factoryRepo({ items: [] });
  writeFileSync(join(dir, 'factory/board.json'), JSON.stringify({ version: 1, jobs: [{ id: '001-x', stage: 'needs-human', title: 'X' }] }));
  const lock = lockPath(dir, 'job-001-x');
  assert.ok(tryLock(lock));
  try {
    const r = await runCli(dir, ['approve', '001-x']);
    assert.equal(r.code, 1);
    assert.match(r.out, /being run by another process/);
  } finally {
    unlock(lock);
  }
});
