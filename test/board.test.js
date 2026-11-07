import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  claimBacklogItem, claimJobId, getJob, parseBacklog, readBoard, slugify, tryLock, unlock, updateJob,
} from '../template/.claude/skills/factory/board.mjs';

const BOARD = new URL('../template/.claude/skills/factory/board.mjs', import.meta.url).href;
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function factoryDir() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-board-'));
  temps.push(dir);
  mkdirSync(join(dir, 'factory/jobs'), { recursive: true });
  writeFileSync(join(dir, 'factory/board.json'), '{ "version": 1, "jobs": [] }\n');
  return dir;
}

// Runs `code` (with board.mjs's exports in scope) in a separate node process.
function inChild(root, code) {
  return new Promise((done, fail) => {
    const script = `import * as b from '${BOARD}'; const root = ${JSON.stringify(root)}; ${code}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => (code === 0 ? done(out.trim()) : fail(new Error(`child exited ${code}`))));
  });
}

test('claimJobId gives every process its own number', async () => {
  const root = factoryDir();
  mkdirSync(join(root, 'factory/jobs/004-earlier'));
  const ids = await Promise.all([...Array(6)].map((_, i) => inChild(root, `console.log(b.claimJobId(root, 'job-${i}'))`)));
  const numbers = ids.map((id) => id.slice(0, 3)).sort();
  assert.deepEqual(numbers, ['005', '006', '007', '008', '009', '010']);
  assert.equal(readdirSync(join(root, 'factory/jobs')).length, 7);
  assert.equal(claimJobId(root, 'next'), '011-next');
});

test('updateJob from several processes loses no updates', async () => {
  const root = factoryDir();
  const bump = 'for (let i = 0; i < 25; i++) b.updateJob(root, "001-x", (j) => { j.count = (j.count || 0) + 1; });';
  await Promise.all([...Array(4)].map(() => inChild(root, bump)));
  const job = getJob(root, '001-x');
  assert.equal(job.count, 100);
  assert.match(job.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(readBoard(root).jobs.length, 1);
});

test('updateJob merges fields into an existing job and keeps the others', () => {
  const root = factoryDir();
  updateJob(root, '001-a', { stage: 'spec', title: 'A' });
  updateJob(root, '002-b', { stage: 'spec' });
  updateJob(root, '001-a', { stage: 'build' });
  assert.deepEqual(readBoard(root).jobs.map((j) => [j.id, j.stage, j.title]), [['001-a', 'build', 'A'], ['002-b', 'spec', undefined]]);
});

test('locks: held ones block, stale ones are taken over', () => {
  const root = factoryDir();
  const lock = join(root, 'factory/.locks/x');
  assert.ok(tryLock(lock));
  assert.ok(!tryLock(lock), 'this process holds it');
  unlock(lock);

  // Held by a process that has exited.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), String(dead));
  assert.ok(tryLock(lock));
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(process.pid));
  unlock(lock);

  // Held by a live process: left alone.
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.ppid));
  assert.ok(!tryLock(lock));
  unlock(lock);

  // A garbled pid file has no holder.
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), '');
  assert.ok(tryLock(lock));
  unlock(lock);
});

test('a lock is never held by two processes at once', async () => {
  const root = factoryDir();
  const grab = `const path = b.lockPath(root, 'x'); let n = 0;
    for (let i = 0; i < 200; i++) {
      if (!b.tryLock(path)) continue;
      const mine = root + '/factory/holder';
      require_fs.writeFileSync(mine, String(process.pid));
      for (let k = 0; k < 2000; k++);
      if (require_fs.readFileSync(mine, 'utf8') !== String(process.pid)) { console.log('overlap'); process.exit(1); }
      b.unlock(path); n++;
    }
    console.log(n);`;
  const code = `import * as require_fs from 'node:fs'; ${grab}`;
  const counts = await Promise.all([...Array(4)].map(() => inChild(root, code)));
  assert.ok(counts.every((c) => /^\d+$/.test(c)), counts.join(','));
});

test('parseBacklog follows the Next rules', () => {
  const text = [
    '# Backlog',
    '<!--',
    '- [ ] Commented out',
    '-->',
    '- [x] Done already (job 001-x)',
    '- [ ] Rate-limit the API',
    '  Outcome: 429s.',
    '    Details: per key.',
    '',
    '  Not part of it (after a blank line).',
    '- [ ] Second <!-- inline note -->',
  ].join('\n');
  const items = parseBacklog(text);
  assert.deepEqual(items.map((i) => i.request), ['Rate-limit the API\nOutcome: 429s.\nDetails: per key.', 'Second']);
  assert.equal(items[0].line, 5);
});

test('claimBacklogItem ticks off the first item and leaves its details', () => {
  const root = factoryDir();
  writeFileSync(join(root, 'factory/backlog.md'), '# Backlog\n\n- [ ] Add CSV export\n  Details: all columns.\n- [ ] Next one\n');
  const item = claimBacklogItem(root, (text) => claimJobId(root, slugify(text)));
  assert.deepEqual(item, { id: '001-add-csv-export', text: 'Add CSV export', request: 'Add CSV export\nDetails: all columns.' });
  assert.equal(readFileSync(join(root, 'factory/backlog.md'), 'utf8'),
    '# Backlog\n\n- [x] Add CSV export (job 001-add-csv-export)\n  Details: all columns.\n- [ ] Next one\n');
  assert.equal(claimBacklogItem(root, () => '002-next-one').id, '002-next-one');
  assert.equal(claimBacklogItem(root, () => assert.fail('nothing left to claim')), null);
});

test('slugify keeps at most five words', () => {
  assert.equal(slugify('Rate-limit the public API per API key!'), 'rate-limit-the-public-api');
  assert.equal(slugify('***'), 'job');
});
