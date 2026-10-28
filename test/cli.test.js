import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dashboard } from '../src/dashboard.js';
import { mergeDefaults } from '../src/install.js';
import { sha256, templateFiles } from '../src/util.js';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-test-'));
  temps.push(dir);
  return dir;
}

function repo({ commit = true } = {}) {
  const dir = tempDir();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  if (commit) {
    writeFileSync(join(dir, 'README.md'), '# test\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  }
  return dir;
}

function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const manifest = (dir) => JSON.parse(read(dir, 'factory/.manifest.json'));

test('init installs every template file and records package-owned hashes', () => {
  const dir = repo();
  const r = run(dir, 'init');
  assert.equal(r.code, 0, r.out);
  for (const rel of templateFiles()) assert.ok(existsSync(join(dir, rel)), rel);

  const m = manifest(dir);
  assert.ok(m.files['.claude/skills/factory/SKILL.md']);
  assert.ok(m.files['factory/dashboard.html']);
  assert.equal(m.files['factory/config.json'], undefined, 'user files are not tracked');

  const ignore = read(dir, '.gitignore');
  assert.match(ignore, /^factory\/board\.json$/m);
  assert.match(ignore, /^\.factory-worktrees\/$/m);
});

test('init works from a subdirectory and installs at the repo root', () => {
  const dir = repo();
  mkdirSync(join(dir, 'src'));
  assert.equal(run(join(dir, 'src'), 'init').code, 0);
  assert.ok(existsSync(join(dir, '.claude/skills/factory/SKILL.md')));
});

test('init refuses outside a repo, without commits, and when already installed', () => {
  assert.match(run(tempDir(), 'init').out, /Not inside a git repository/);
  assert.match(run(repo({ commit: false }), 'init').out, /no commits yet/);
  const dir = repo();
  run(dir, 'init');
  const again = run(dir, 'init');
  assert.equal(again.code, 1);
  assert.match(again.out, /already installed/);
});

test('init keeps files that already exist and does not duplicate .gitignore entries', () => {
  const dir = repo();
  mkdirSync(join(dir, 'factory'));
  writeFileSync(join(dir, 'factory/backlog.md'), 'mine\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\nfactory/board.json\n');
  run(dir, 'init');
  assert.equal(read(dir, 'factory/backlog.md'), 'mine\n');
  const ignore = read(dir, '.gitignore');
  assert.equal(ignore.match(/factory\/board\.json/g).length, 1);
  assert.match(ignore, /\.factory-worktrees\//);
});

test('update overwrites untouched files and is a no-op when current', () => {
  const dir = repo();
  run(dir, 'init');
  assert.match(run(dir, 'update').out, /Already up to date/);

  // Simulate an older shipped version: file content and manifest hash agree.
  const rel = '.claude/agents/factory-builder.md';
  const old = 'old version\n';
  writeFileSync(join(dir, rel), old);
  const m = manifest(dir);
  m.files[rel] = sha256(Buffer.from(old));
  writeFileSync(join(dir, 'factory/.manifest.json'), JSON.stringify(m));

  const r = run(dir, 'update');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /~ \.claude\/agents\/factory-builder\.md/);
  assert.notEqual(read(dir, rel), old);
});

test('update leaves locally edited files alone and writes .new beside them', () => {
  const dir = repo();
  run(dir, 'init');
  const rel = '.claude/skills/factory/SKILL.md';
  writeFileSync(join(dir, rel), 'my edits\n');

  const r = run(dir, 'update');
  assert.match(r.out, /local edits/);
  assert.equal(read(dir, rel), 'my edits\n');
  assert.ok(existsSync(join(dir, `${rel}.new`)));

  // Still flagged next time, until resolved.
  assert.match(run(dir, 'update').out, /local edits/);

  // --force overwrites and cleans up the .new file.
  run(dir, 'update', '--force');
  assert.notEqual(read(dir, rel), 'my edits\n');
  assert.ok(!existsSync(join(dir, `${rel}.new`)));
  assert.match(run(dir, 'update').out, /Already up to date/);
});

test('update never touches user files, restores missing ones, and adds new config keys', () => {
  const dir = repo();
  run(dir, 'init');
  writeFileSync(join(dir, 'factory/backlog.md'), '- [ ] my feature\n');
  rmSync(join(dir, 'factory/board.json'));
  const config = JSON.parse(read(dir, 'factory/config.json'));
  config.maxRounds = 5;
  delete config.onApprove;
  delete config.tasks; // as in a v0.1.0 install, before task sources existed
  delete config.reviewers.ux;
  config.reviewers.perf = { model: 'sonnet', enabled: true };
  writeFileSync(join(dir, 'factory/config.json'), JSON.stringify(config));

  const r = run(dir, 'update');
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir, 'factory/backlog.md'), '- [ ] my feature\n');
  assert.ok(existsSync(join(dir, 'factory/board.json')));

  const merged = JSON.parse(read(dir, 'factory/config.json'));
  assert.equal(merged.maxRounds, 5);
  assert.equal(merged.onApprove, 'merge');
  assert.deepEqual(merged.tasks, { source: 'backlog', githubLabel: 'factory' });
  assert.ok(merged.reviewers.ux);
  assert.ok(merged.reviewers.perf, 'custom reviewers are kept');
});

test('update refuses when the factory is not installed', () => {
  const r = run(repo(), 'update');
  assert.equal(r.code, 1);
  assert.match(r.out, /isn't installed/);
});

test('mergeDefaults adds missing keys only', () => {
  const target = { a: 1, nested: { x: 1 } };
  const added = mergeDefaults(target, { a: 2, b: 3, nested: { x: 2, y: 4 } });
  assert.deepEqual(target, { a: 1, b: 3, nested: { x: 1, y: 4 } });
  assert.deepEqual(added, ['b', 'nested.y']);
});

test('dashboard serves factory/ and blocks paths outside it', async () => {
  const dir = repo();
  run(dir, 'init');
  mkdirSync(join(dir, 'factory/jobs/001-x'), { recursive: true });
  writeFileSync(join(dir, 'factory/jobs/001-x/spec.md'), '# Spec\n');

  const server = await dashboard(dir, { port: 0, open: false }, () => {});
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);

    const board = await fetch(`${base}/board.json`);
    assert.deepEqual(await board.json(), { version: 1, jobs: [] });

    const spec = await fetch(`${base}/jobs/001-x/spec.md`);
    assert.equal(await spec.text(), '# Spec\n');

    assert.equal((await fetch(`${base}/jobs/001-x/missing.md`)).status, 404);
    assert.notEqual((await fetch(`${base}/%2e%2e/README.md`)).status, 200);
    assert.equal((await fetch(`${base}/board.json`, { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
});

test('cli prints help and rejects unknown commands', () => {
  assert.match(run(tempDir()).out, /Usage:/);
  const r = run(tempDir(), 'frobnicate');
  assert.equal(r.code, 1);
  assert.match(r.out, /Unknown command/);
});
