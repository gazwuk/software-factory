import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { isReady, prepareWorktree, readyMarker, unlinkFiles } from '../template/.claude/skills/factory/worktree.mjs';

const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'factory-worktree-'));
  temps.push(root);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.env\n.env.local\ncerts\n.factory-worktrees/\n');
  writeFileSync(join(root, 'tracked.txt'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  writeFileSync(join(root, 'notes.txt'), 'not ignored\n');
  mkdirSync(join(root, 'certs'));
  writeFileSync(join(root, 'certs/dev.pem'), 'pem\n');
  const dir = join(root, '.factory-worktrees/001-x');
  git('worktree', 'add', '-q', dir, '-b', 'factory/001-x', 'main');
  return { root, dir };
}

test('links gitignored files and folders, skipping missing and tracked ones', () => {
  const { root, dir } = repo();
  const r = prepareWorktree(root, dir, { link: ['.env', 'certs', '.env.local', 'tracked.txt'] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.links, ['.env', 'certs']);
  assert.deepEqual(r.skipped, ['.env.local (not in the main checkout)', 'tracked.txt (the worktree already has it)']);
  assert.ok(lstatSync(join(dir, '.env')).isSymbolicLink());
  assert.equal(readFileSync(join(dir, 'certs/dev.pem'), 'utf8'), 'pem\n');
  // Linked files stay out of git, so the builder can't commit them.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');

  // Running again is a no-op; unlinking leaves the originals alone.
  assert.deepEqual(prepareWorktree(root, dir, { link: ['.env', 'certs'] }).links, ['.env', 'certs']);
  unlinkFiles(dir, r.links);
  assert.ok(!existsSync(join(dir, '.env')));
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'SECRET=1\n');
});

test('refuses links that could be committed or leave the repo', () => {
  const { root, dir } = repo();
  const open = prepareWorktree(root, dir, { link: ['notes.txt'] });
  assert.equal(open.ok, false);
  assert.match(open.error, /"notes.txt" isn't gitignored/);
  assert.ok(!existsSync(join(dir, 'notes.txt')));
  assert.match(prepareWorktree(root, dir, { link: ['../outside'] }).error, /inside the repo/);

  // `certs/` matches folders only, and a linked folder is a symlink.
  writeFileSync(join(dir, '.gitignore'), '.env\ncerts/\n');
  assert.match(prepareWorktree(root, dir, { link: ['certs'] }).error, /without a trailing slash/);
});

test('runs setup in the worktree and marks it ready only when everything worked', () => {
  const { root, dir } = repo();
  assert.equal(isReady(dir), false);
  assert.ok(readyMarker(dir).includes(join('.git', 'worktrees')), 'marker sits outside the work tree');

  const failed = prepareWorktree(root, dir, { setup: 'echo installing; echo "no lockfile" >&2; exit 3' }, { mark: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.setup.exit, 3);
  assert.match(failed.error, /failed \(exit 3\): no lockfile/);
  assert.equal(isReady(dir), false);

  const ok = prepareWorktree(root, dir, { link: ['.env'], setup: 'cat .env > setup-ran.txt' }, { mark: true });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(readFileSync(join(dir, 'setup-ran.txt'), 'utf8'), 'SECRET=1\n');
  assert.equal(isReady(dir), true);
  assert.deepEqual(JSON.parse(readFileSync(readyMarker(dir), 'utf8')).links, ['.env']);
});
