import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { addedLines, diffPath, globMatch, grepAdded, numberDiff, numberedDiff, parseChangedLines, prepareRound, selectReviewers, splitProblems, tryCheck } from '../template/.claude/skills/factory/round.mjs';

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

function jobRepo(checks, baseFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-round-'));
  temps.push(root);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), '# test\n');
  for (const [file, text] of Object.entries(baseFiles)) writeFileSync(join(root, file), text);
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
  assert.match(readFileSync(join(jobDir, 'round-2/round.md'), 'utf8'), new RegExp(`round\\.mjs diff \\S+ ${r1.sha} ${r2.sha}`));
});

test('the UI probe runs for probe reviewers, and its new failures block the round', () => {
  const { root, commit, jobDir } = jobRepo({});
  const config = JSON.parse(readFileSync(join(root, 'factory/config.json'), 'utf8'));
  config.reviewers.ui.probe = true;
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(config));
  const calls = [];
  const probe = (summary) => (r, id, n) => { calls.push([id, n]); return summary; };

  // No probe reviewer selected: the probe doesn't run.
  commit('api.js', 'x\n');
  const quiet = prepareRound(root, '001-x', 1, { probe: probe({ status: 'ran', failures: 0, warnings: 0 }) });
  assert.equal(quiet.ok, true);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(readFileSync(join(jobDir, 'round-1/round.md'), 'utf8'), /UI probe/);

  // A stylesheet selects ui, so the probe runs; a new failure blocks like a failed check.
  commit('app.css', 'a{}\n');
  const file = join(jobDir, 'round-1/probe.md');
  const blocked = prepareRound(root, '001-x', 1, {
    probe: probe({ status: 'ran', failures: 2, warnings: 1, file, top: ['overflow: page is 600px wide'] }),
  });
  assert.deepEqual(calls, [['001-x', 1]]);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.failed, ['ui-probe']);
  const state = JSON.parse(readFileSync(join(jobDir, 'round-1/round.json'), 'utf8'));
  assert.equal(state.reviewers, null);
  assert.equal(state.checks.ok, false);
  assert.deepEqual(state.checks.results.map((c) => [c.name, c.exit]), [['ui-probe', 1]]);
  assert.equal(state.probe.failures, 2);
  const md = readFileSync(join(jobDir, 'round-1/round.md'), 'utf8');
  assert.match(md, /\*\*Failed:\*\* ui-probe/);
  assert.match(md, /overflow: page is 600px wide/);
  assert.match(md, /\*\*2 new failure\(s\)\.\*\*/);

  // For the reviewer evals, failures can go to the reviewers instead of blocking.
  const advisory = prepareRound(root, '001-x', 1, {
    probeBlocks: false, probe: probe({ status: 'ran', failures: 2, warnings: 1, file, top: [] }),
  });
  assert.equal(advisory.ok, true);
  assert.ok(advisory.run.some((r) => r.name === 'ui'));
  assert.match(readFileSync(join(jobDir, 'round-1/round.md'), 'utf8'), /\*\*2 new failure\(s\)\*\*, for the reviewers to answer/);
  assert.doesNotMatch(readFileSync(join(jobDir, 'round-1/round.md'), 'utf8'), /ui-probe/);

  // Passing, or skipped: reviewers run, and round.md says what the probe did.
  const passed = prepareRound(root, '001-x', 1, { probe: probe({ status: 'ran', failures: 0, warnings: 3, file }) });
  assert.equal(passed.ok, true);
  assert.ok(passed.run.some((r) => r.name === 'ui'));
  assert.match(readFileSync(join(jobDir, 'round-1/round.md'), 'utf8'), /No new failures\. 3 warning\(s\)/);

  const skipped = prepareRound(root, '001-x', 1, { probe: probe({ status: 'skipped', reason: 'no ui.serve.', failures: 0, warnings: 0 }) });
  assert.equal(skipped.ok, true);
  const skippedMd = readFileSync(join(jobDir, 'round-1/round.md'), 'utf8');
  assert.match(skippedMd, /Skipped: no ui\.serve\. Review from the diff\./);
  assert.match(skippedMd, /No checks configured/);
});

test('parseChangedLines lists the added and changed lines of each file', () => {
  const patch = [
    'diff --git a/a.css b/a.css', '--- a/a.css', '+++ b/a.css',
    '@@ -2 +2 @@', '-x', '+y',
    '@@ -5,0 +6,3 @@', '+++ not a header', '+b', '+c',
    'diff --git a/gone.css b/gone.css', '--- a/gone.css', '+++ /dev/null', '@@ -1 +0,0 @@', '-z',
    'diff --git a/new.css b/new.css', '--- /dev/null', '+++ b/new.css', '@@ -0,0 +1,2 @@', '+p', '+q',
  ].join('\n');
  const lines = parseChangedLines(patch);
  assert.deepEqual([...lines.keys()], ['a.css', 'new.css']);
  assert.deepEqual([...lines.get('a.css')], [2, 6, 7, 8]);
  assert.deepEqual([...lines.get('new.css')], [1, 2]);
});

// A stand-in for stylelint's unix format: one `path:line:col: message` per literal
// colour, with absolute paths as eslint prints them.
const LINT = `import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
let found = 0;
for (const f of process.argv.slice(2)) {
  readFileSync(f, 'utf8').split('\\n').forEach((text, i) => {
    if (/#[0-9a-f]{3}/.test(text)) { found++; console.log(\`\${resolve(f)}:\${i + 1}:3: literal colour\`); }
  });
}
process.exit(found ? 1 : 0);
`;

test('a UI gate sees only the changed files and fails only on lines the change touched', () => {
  const gate = { command: 'node lint.mjs {files}', files: ['*.css'], scope: 'lines' };
  const { root, wt, commit, jobDir } = jobRepo({ 'ui-tokens': gate }, {
    'lint.mjs': LINT,
    'old.css': 'a {\n  color: #333;\n}\n',
    'my theme.css': 'b { color: #222; }\n',
  });
  const md = () => readFileSync(join(jobDir, 'round-1/round.md'), 'utf8');

  // No stylesheet changed: the gate is skipped, and passes.
  commit('api.js', 'x\n');
  assert.equal(prepareRound(root, '001-x', 1).ok, true);
  assert.match(md(), /\| ui-tokens \| `node lint\.mjs \{files\}` \| skipped: no changed files it covers \|/);

  // A token added to files with older literals (one with a space in its name): passes.
  commit('old.css', 'a {\n  color: #333;\n  background: var(--bg);\n}\n');
  commit('my theme.css', 'b { color: #222; }\nc { color: var(--fg); }\n');
  assert.equal(prepareRound(root, '001-x', 1).ok, true);
  assert.match(md(), /passed: 2 older problems on lines the change didn't touch/);

  // A literal colour on a new line fails the gate; the builder sees only that line.
  commit('old.css', 'a {\n  color: #333;\n  border-color: #444;\n}\n');
  const failed = prepareRound(root, '001-x', 1);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.failed, ['ui-tokens']);
  assert.match(md(), /failed \(exit 1\): 1 problem on changed lines; 2 older ignored/);
  assert.match(md(), /old\.css:3:3: literal colour/);
  assert.doesNotMatch(md(), /old\.css:2:/);

  // Before committing, `round.mjs check` sees uncommitted and untracked work too.
  commit('old.css', 'a {\n  color: #333;\n}\n');
  assert.equal(tryCheck(root, 'ui-tokens', wt).ok, true);
  writeFileSync(join(wt, 'new.css'), 'd { color: #555; }\n');
  const tried = tryCheck(root, 'ui-tokens', wt);
  assert.equal(tried.ok, false);
  assert.match(tried.output, /new\.css:1:3: literal colour/);
  assert.throws(() => tryCheck(root, 'nope', wt), /no check named "nope"/);
});

test('a lines gate whose output has no locations fails on any problem', () => {
  const { root, commit, jobDir } = jobRepo({ 'ui-a11y': { command: 'echo broken config; exit 2', scope: 'lines' } });
  commit('app.css', 'a{}\n');
  const r = prepareRound(root, '001-x', 1);
  assert.deepEqual(r.failed, ['ui-a11y']);
  assert.match(readFileSync(join(jobDir, 'round-1/round.md'), 'utf8'), /failed \(exit 2\): no file:line locations in its output, so every problem counts/);
});

test('splitProblems reads unix and stylish layouts, with colour codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-split-'));
  temps.push(dir);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/App.jsx'), '');
  writeFileSync(join(dir, 'src/a.css'), '');
  const output = [
    join(dir, 'src/App.jsx'),
    '  4:7  error  Visible, non-interactive elements with click handlers      jsx-a11y/click-events-have-key-events',
    '  9:1  error  img elements must have an alt prop  jsx-a11y/alt-text',
    '',
    '\x1b[4msrc/a.css\x1b[24m',
    '  \x1b[2m2:3\x1b[22m  ✖  Expected variable for "#333"',
    '',
    'src/a.css:5:1: Expected variable for "#444" [error]',
    'nowhere.css:1:1: not a file in the worktree',
    '✖ 4 problems (4 errors, 0 warnings)',
    '  2 errors potentially fixable with the "--fix" option.',
  ].join('\n');
  const lines = new Map([['src/App.jsx', new Set([9])], ['src/a.css', new Set([2, 5])]]);
  assert.deepEqual(splitProblems(output, dir, lines), {
    added: [
      'src/App.jsx:9:1  error  img elements must have an alt prop  jsx-a11y/alt-text',
      'src/a.css:2:3  ✖  Expected variable for "#333"',
      'src/a.css:5:1: Expected variable for "#444" [error]',
    ],
    older: ['src/App.jsx:4:7  error  Visible, non-interactive elements with click handlers  jsx-a11y/click-events-have-key-events'],
  });
  assert.equal(splitProblems('Error: Could not find config file.', dir, lines), null);
});

test('addedLines numbers each added line by its place in the file', () => {
  const patch = [
    'diff --git a/a.css b/a.css', '--- a/a.css', '+++ b/a.css', '@@ -2 +2 @@', '-x', '+y',
    '@@ -5,0 +6,2 @@', '+++ not a header', '+b',
  ].join('\n');
  assert.deepEqual(addedLines(patch), [
    { file: 'a.css', line: 2, text: 'y' },
    { file: 'a.css', line: 6, text: '++ not a header' },
    { file: 'a.css', line: 7, text: 'b' },
  ]);
});

test('diffPath and addedLines read paths Git quotes or follows with a tab', () => {
  assert.equal(diffPath('b/a.css'), 'b/a.css');
  assert.equal(diffPath('b/my theme.css\t'), 'b/my theme.css');
  assert.equal(diffPath('"b/caf\\303\\251.css"'), 'b/café.css');
  assert.equal(diffPath('"b/say \\"hi\\"\\tnow.css"'), 'b/say "hi"\tnow.css');
  const patch = [
    'diff --git a/my theme.css b/my theme.css', '--- a/my theme.css\t', '+++ b/my theme.css\t', '@@ -1,0 +2 @@', '+x',
    'diff --git "a/caf\\303\\251.css" "b/caf\\303\\251.css"', '--- "a/caf\\303\\251.css"', '+++ "b/caf\\303\\251.css"', '@@ -3,0 +4 @@', '+y',
  ].join('\n');
  assert.deepEqual(addedLines(patch), [
    { file: 'my theme.css', line: 2, text: 'x' },
    { file: 'café.css', line: 4, text: 'y' },
  ]);
});

test('a lines gate fails on new problems in files whose names Git quotes', () => {
  const gate = { command: 'node lint.mjs {files}', files: ['*.css'], scope: 'lines' };
  const { root, commit } = jobRepo({ 'ui-tokens': gate }, {
    'lint.mjs': LINT, 'my theme.css': 'a { color: #222; }\n', 'café.css': 'a { color: #222; }\n',
  });
  for (const file of ['my theme.css', 'café.css']) {
    commit(file, 'a { color: #222; }\nb { color: #333; }\n');
    const r = prepareRound(root, '001-x', 1);
    assert.equal(r.ok, false, file);
    assert.deepEqual(r.failed, ['ui-tokens']);
    commit(file, 'a { color: #222; }\n');
  }
});

test('grepAdded cites file lines, not positions in the diff, and round.md gives the command', () => {
  const { root, wt, commit, jobDir } = jobRepo({}, { 'b.css': 'a {}\nb {}\nc {}\n' });
  commit('a.js', 'one\ntwo\nthree\n');
  commit('b.css', 'a {}\nb { outline: none; }\nc {}\nd { color: #333; }\n');
  const mergeBase = execFileSync('git', ['merge-base', 'main', 'HEAD'], { cwd: wt }).toString().trim();
  assert.deepEqual(grepAdded(wt, mergeBase, 'HEAD', 'outline:\\s*none|#[0-9a-f]{3}'), [
    'b.css:2: b { outline: none; }',
    'b.css:4: d { color: #333; }',
  ]);
  assert.deepEqual(grepAdded(wt, mergeBase, 'HEAD', 'nothing-matches'), []);
  prepareRound(root, '001-x', 1);
  assert.match(readFileSync(join(jobDir, 'round-1/round.md'), 'utf8'), /round\.mjs grep \S+001-x <since> [0-9a-f]{40} '<regex>'/);
});

test('numberDiff prints each line\'s number in its file beside the diff', () => {
  const patch = [
    'diff --git a/a.css b/a.css', 'index 1..2 100644', '--- a/a.css', '+++ b/a.css',
    '@@ -1,3 +1,4 @@ .a', ' a {}', '-b {}', '+b { color: #333; }', '+c {}', ' d {}',
    'diff --git a/gone.css b/gone.css', 'deleted file mode 100644', '--- a/gone.css', '+++ /dev/null', '@@ -1 +0,0 @@', '-x {}',
  ].join('\n');
  assert.equal(numberDiff(patch), [
    '=== a.css',
    '      @@ -1,3 +1,4 @@ .a',
    '    1  a {}',
    '      -b {}',
    '    2 +b { color: #333; }',
    '    3 +c {}',
    '    4  d {}',
    '',
    '=== gone.css (deleted)',
    '      @@ -1 +0,0 @@',
    '      -x {}',
  ].join('\n'));
});

test('numberDiff keeps mode changes, renames and files with no hunks', () => {
  const patch = [
    'diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755',
    'diff --git a/old name.css b/new name.css', 'similarity index 100%', 'rename from old name.css', 'rename to new name.css',
    'diff --git a/a.js b/lib/a.js', 'similarity index 80%', 'rename from a.js', 'rename to lib/a.js', 'index 1..2 100644',
    '--- a/a.js', '+++ b/lib/a.js', '@@ -2 +2 @@', '-x', '+y',
    'diff --git "a/caf\\303\\251.png" "b/caf\\303\\251.png"', 'index 1..2 100644', 'Binary files "a/caf\\303\\251.png" and "b/caf\\303\\251.png" differ',
    'diff --git a/my theme.css b/my theme.css', 'new file mode 100644', 'index 0..1',
    'diff --git a/go.sh b/go.sh', 'new file mode 100755', 'index 0..1',
    'diff --git a/link b/link', 'new file mode 120000', 'index 0..1', '--- /dev/null', '+++ b/link', '@@ -0,0 +1 @@', '+go.sh',
    '\\ No newline at end of file',
  ].join('\n');
  assert.equal(numberDiff(patch), [
    '=== run.sh',
    '      old mode 100644',
    '      new mode 100755',
    '',
    '=== new name.css (renamed from old name.css)',
    '',
    '=== lib/a.js (renamed from a.js)',
    '      @@ -2 +2 @@',
    '      -x',
    '    2 +y',
    '',
    '=== café.png',
    '      Binary files "a/caf\\303\\251.png" and "b/caf\\303\\251.png" differ',
    '',
    '=== my theme.css',
    '      new file mode 100644',
    '',
    '=== go.sh',
    '      new file mode 100755',
    '',
    '=== link',
    '      new file mode 120000',
    '      @@ -0,0 +1 @@',
    '    1 +go.sh',
    '      \\ No newline at end of file',
  ].join('\n'));
});

test('numberedDiff numbers a real worktree diff and can show only some files', () => {
  const { wt, commit } = jobRepo({}, { 'b.css': 'a {}\nb {}\nc {}\nd {}\ne {}\n' });
  commit('a.js', 'one\n');
  commit('b.css', 'a {}\nb {}\nc {}\nd { color: #333; }\ne {}\n');
  const mergeBase = execFileSync('git', ['merge-base', 'main', 'HEAD'], { cwd: wt }).toString().trim();
  const all = numberedDiff(wt, mergeBase, 'HEAD');
  assert.match(all, /=== a\.js\n {6}new file mode 100644\n.*\n {4}1 \+one/);
  assert.match(all, /^ {4}4 \+d \{ color: #333; \}$/m);
  assert.doesNotMatch(numberedDiff(wt, mergeBase, 'HEAD', ['b.css']), /a\.js/);

  // A mode change and a pure rename have no hunks, and still show.
  chmodSync(join(wt, 'a.js'), 0o755);
  execFileSync('git', ['mv', 'b.css', 'c.css'], { cwd: wt });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'mode, rename'], { cwd: wt });
  const moved = numberedDiff(wt, 'HEAD~1', 'HEAD');
  assert.match(moved, /^=== a\.js\n {6}old mode 100644\n {6}new mode 100755$/m);
  assert.match(moved, /^=== c\.css \(renamed from b\.css\)$/m);
});
