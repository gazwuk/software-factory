import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { globMatch, prepareRound, selectReviewers } from '../template/.claude/skills/factory/round.mjs';

const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test('globMatch handles **, *, braces and bare file names', () => {
  assert.ok(globMatch('**/components/**', 'src/components/Button.tsx'));
  assert.ok(globMatch('**/components/**', 'components/x.js'));
  assert.ok(!globMatch('**/components/**', 'src/componentsx/a.js'));
  assert.ok(globMatch('src/**', 'src/a/b/c.js'));
  assert.ok(!globMatch('src/*', 'src/a/b.js'));
  assert.ok(globMatch('*.{css,scss}', 'web/styles/main.scss'));
  assert.ok(!globMatch('*.{css,scss}', 'web/styles/main.ts'));
  assert.ok(globMatch('package.json', 'packages/api/package.json'));
  assert.ok(globMatch('*auth*', 'src/lib/oauth.ts'));
  assert.ok(globMatch('.github/workflows/**', '.github/workflows/ci.yml'));
  assert.ok(!globMatch('.github/workflows/**', 'x.github/workflows/ci.yml'));
  assert.ok(globMatch('file?.md', 'docs/file1.md'));
});

const CONFIG = {
  security: { model: 'sonnet', escalateModel: 'opus', escalatePaths: ['**/auth/**'] },
  ui: { model: 'sonnet', paths: ['*.css'] },
  code: { model: 'sonnet' },
};

function select({ prev = null, changes = {}, verdicts = {}, full }) {
  return selectReviewers({
    names: ['security', 'ui', 'code'],
    config: CONFIG,
    prev,
    mergeBase: 'mb',
    verdictOf: (name) => verdicts[name] ?? null,
    changedSince: (sha) => changes[sha] ?? [],
    fullChange: full ?? changes.mb ?? [],
  });
}

test('round 1 runs reviewers whose paths match, and escalates by path', () => {
  const plain = select({ changes: { mb: ['src/api.js'] } });
  assert.equal(plain.code.run, true);
  assert.equal(plain.security.model, 'sonnet');
  assert.equal(plain.ui.run, false);
  assert.match(plain.ui.reason, /no changed files match/);

  const auth = select({ changes: { mb: ['src/auth/login.js', 'web/app.css'] } });
  assert.equal(auth.security.model, 'opus');
  assert.match(auth.security.reason, /src\/auth\/login\.js/);
  assert.equal(auth.ui.run, true);
  assert.equal(auth.ui.since, 'mb');
});

test('later rounds re-run CHANGES reviewers and anyone whose files changed since they passed', () => {
  const prev = {
    round: 1, sha: 's1',
    reviewers: {
      security: { run: true }, code: { run: true },
      ui: { run: false, since: 'mb', lastReview: null },
    },
  };
  // The fix touched only a CSS file.
  const r = select({
    prev,
    verdicts: { security: 'CHANGES', code: 'PASS' },
    changes: { s1: ['web/app.css'], mb: ['src/api.js', 'web/app.css'] },
  });
  assert.deepEqual([r.security.run, r.code.run, r.ui.run], [true, true, true]);
  assert.match(r.security.reason, /asked for changes in round 1/);
  assert.equal(r.security.since, 's1');
  assert.equal(r.security.lastReview, 'round-1/review-security.md');
  assert.equal(r.ui.since, 'mb', 'ui never reviewed, so it reviews the whole change');
  assert.equal(r.ui.lastReview, null);

  // Nothing changed since round 1 for a reviewer that passed → skipped, carried forward.
  const quiet = select({ prev, verdicts: { security: 'CHANGES', code: 'PASS' }, changes: { s1: [] } });
  assert.equal(quiet.code.run, false);
  assert.equal(quiet.code.since, 's1');
  assert.match(quiet.code.reason, /since it passed/);
  assert.equal(quiet.security.run, true, 'a CHANGES reviewer always re-runs');
});

test('a skipped reviewer keeps the commit it last passed at', () => {
  const prev = {
    round: 2, sha: 's2',
    reviewers: { security: { run: false, since: 's1', lastReview: 'round-1/review-security.md' } },
  };
  const r = selectReviewers({
    names: ['security'], config: CONFIG, prev, mergeBase: 'mb',
    verdictOf: () => null,
    changedSince: (sha) => (sha === 's1' ? ['src/x.js'] : []),
    fullChange: ['src/x.js'],
  });
  assert.equal(r.security.run, true);
  assert.equal(r.security.since, 's1');
  assert.equal(r.security.lastReview, 'round-1/review-security.md');
});

test('a missing verdict counts as needing a re-run', () => {
  const prev = { round: 1, sha: 's1', reviewers: { code: { run: true } } };
  const r = selectReviewers({
    names: ['code'], config: CONFIG, prev, mergeBase: 'mb',
    verdictOf: () => null, changedSince: () => [], fullChange: [],
  });
  assert.equal(r.code.run, true);
  assert.match(r.code.reason, /no verdict/);
});

// ---------- prepareRound against a real repo ----------

function jobRepo(checks) {
  const root = mkdtempSync(join(tmpdir(), 'factory-round-'));
  temps.push(root);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), '# test\n');
  writeFileSync(join(root, '.gitignore'), 'factory/\n.factory-worktrees/\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({
    baseBranch: 'main', checks,
    reviewers: {
      security: { model: 'sonnet', enabled: true },
      ui: { model: 'sonnet', enabled: true, paths: ['*.css'] },
      code: { model: 'sonnet', enabled: true },
    },
  }));
  writeFileSync(join(root, 'factory/board.json'), JSON.stringify({
    version: 1, jobs: [{ id: '001-x', reviewers: ['security', 'ui', 'code'] }],
  }));
  git('worktree', 'add', '-q', '.factory-worktrees/001-x', '-b', 'factory/001-x', 'main');
  const wt = join(root, '.factory-worktrees/001-x');
  const commit = (file, text) => {
    writeFileSync(join(wt, file), text);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: wt });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', file], { cwd: wt });
  };
  return { root, wt, commit, jobDir: join(root, 'factory/jobs/001-x') };
}

test('prepareRound gates on checks and dirty worktrees, then selects reviewers', () => {
  const { root, wt, commit, jobDir } = jobRepo({ test: 'test -f ok.txt' });
  commit('api.js', 'x\n');

  const failing = prepareRound(root, '001-x', 1);
  assert.equal(failing.ok, false);
  assert.deepEqual(failing.failed, ['test']);
  assert.match(readFileSync(join(jobDir, 'round-1/round.md'), 'utf8'), /\*\*Failed:\*\* test/);
  assert.equal(JSON.parse(readFileSync(join(jobDir, 'round-1/round.json'), 'utf8')).reviewers, null);

  writeFileSync(join(wt, 'ok.txt'), '');
  const dirty = prepareRound(root, '001-x', 1);
  assert.deepEqual(dirty.failed, ['uncommitted changes']);

  commit('ok.txt', '');
  const r1 = prepareRound(root, '001-x', 1);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.run.map((r) => r.name), ['security', 'code']);
  assert.deepEqual(r1.skipped, ['ui']);
  const md = readFileSync(join(jobDir, 'round-1/round.md'), 'utf8');
  assert.match(md, /All passed on this commit/);
  assert.match(md, /\| ui \| skipped \|/);

  // Round 1 verdicts: security wants changes, code passes. The fix adds a stylesheet.
  writeFileSync(join(jobDir, 'round-1/review-security.md'), 'VERDICT: CHANGES\n');
  writeFileSync(join(jobDir, 'round-1/review-code.md'), 'VERDICT: PASS\n');
  commit('app.css', 'a{}\n');
  const r2 = prepareRound(root, '001-x', 2);
  assert.deepEqual(r2.run.map((r) => r.name), ['security', 'ui', 'code']);
  const state = JSON.parse(readFileSync(join(jobDir, 'round-2/round.json'), 'utf8'));
  assert.equal(state.reviewers.code.since, r1.sha);
  assert.equal(state.reviewers.ui.since, state.mergeBase);
  assert.match(readFileSync(join(jobDir, 'round-2/round.md'), 'utf8'), new RegExp(`diff ${r1.sha} ${r2.sha}`));
});
