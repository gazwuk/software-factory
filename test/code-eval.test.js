import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { loadCases, main, parseArgs, rescore } from './evals/code.mjs';
import { scoreReview } from './evals/score.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CODE = join(REPO, 'test/evals/code');
const CASES = loadCases();
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const show = (sha, file) => execFileSync('git', ['show', `${sha}:${file}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
const hasCommit = (sha) => {
  try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: REPO, stdio: 'ignore' }); return true; } catch { return false; }
};
const history = CASES.every((c) => hasCommit(c.base) && hasCommit(c.head));

test('every case defect points at the lines it describes in the reviewed commit', { skip: !history && 'a shallow clone lacks the cases\' commits' }, () => {
  for (const c of CASES) {
    const spans = [];
    for (const d of c.defects) {
      assert.equal(d.lane, 'code', `${c.id}/${d.id}`);
      assert.ok(d.terms?.length && d.terms.every((t) => t === t.toLowerCase()), `${d.id}: terms must be lowercase and not empty`);
      for (const loc of d.locations) {
        const lines = show(c.head, loc.file).split('\n');
        const [from, to] = loc.lines;
        assert.ok(from >= 1 && to >= from && to <= lines.length, `${d.id}: ${loc.file}:${from}-${to} is outside the file`);
        assert.ok(lines.slice(from - 1, to).join('\n').includes(loc.text), `${d.id}: "${loc.text}" isn't in ${loc.file}:${from}-${to}`);
        for (const s of spans) {
          const overlaps = s.file === loc.file && from <= s.to && to >= s.from;
          assert.ok(!overlaps || s.id === d.id, `${d.id} and ${s.id} overlap in ${loc.file}`);
        }
        spans.push({ id: d.id, file: loc.file, from, to });
      }
    }
  }
});

test('every case has its job files and a unique id', () => {
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  for (const c of CASES) {
    for (const f of ['request.md', 'spec.md', 'build.md']) assert.ok(existsSync(join(CODE, 'jobs', c.id, f)), `${c.id}/${f}`);
  }
  assert.ok(CASES.reduce((n, c) => n + c.defects.length, 0) >= 20);
});

test('parseArgs takes case ids and refuses unknown ones', () => {
  assert.deepEqual(parseArgs(['--cases', 'pr9-runner-progress', '--runs', '1']).cases, ['pr9-runner-progress']);
  assert.throws(() => parseArgs(['--cases', 'nope']), /--cases takes ids/);
  assert.throws(() => parseArgs(['--runs', '0']), /--runs/);
});

const PR9 = CASES.find((c) => c.id === 'pr9-runner-progress');

const REVIEW = `VERDICT: CHANGES
# Code review — pr9-runner-progress, round 1

## Summary
Two problems.

## Blocking
1. **Activity cleanup can skip the unlock** — \`runner.mjs:678\`
   Problem: rmSync can throw in the finally, so unlock(lock) never runs.
   Required change: make the cleanup non-fatal.
2. **Heartbeat interval leaks** — \`template/.claude/skills/factory/runner.mjs:10\`
   Problem: …

## Coverage
- Read: template/.claude/skills/factory/runner.mjs
- Not read: None.
`;

test('scoreReview finds a case defect by a bare file name and counts the rest as unmatched', () => {
  const s = scoreReview({ review: REVIEW, lane: 'code', fixture: PR9, probe: null });
  assert.deepEqual(s.found, ['activity-cleanup-throws']);
  assert.equal(s.blocking, 2);
  assert.equal(s.matched, 1);
  assert.equal(s.recall, 0.5);
});

test('a finding that cites a defect\'s lines without any of its terms doesn\'t find it', () => {
  const broad = REVIEW.replace('Problem: …', 'Problem: drive() has no test.').replace('runner.mjs:10`', 'runner.mjs:600-690`');
  const s = scoreReview({ review: broad, lane: 'code', fixture: PR9, probe: null });
  assert.deepEqual(s.found, ['activity-cleanup-throws']);
  assert.equal(s.matched, 1, 'the missing-test finding spans the defect but names none of its terms');
});

test('rescore scores saved reviews again and rewrites the summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-eval-rescore-'));
  temps.push(dir);
  const path = join(dir, 'results.json');
  const stale = { recall: 0, found: [], blocking: 0, matched: 0, unmatched: 0, cost: 0.25 };
  writeFileSync(path, JSON.stringify({ variant: 'code-sonnet', runs: 1, cases: [PR9.id], results: [{ cases: { [PR9.id]: { ...stale, review: REVIEW } } }] }));
  const result = rescore(path);
  assert.deepEqual(result.results[0].cases[PR9.id].found, ['activity-cleanup-throws']);
  assert.equal(result.results[0].cases[PR9.id].cost, 0.25);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).summary.recall, { mean: 0.5, min: 0.5, max: 0.5 });
});

test('eval:code-reviewer rebuilds a case as a job and scores the review (fake agent)', { skip: !history && 'a shallow clone lacks the cases\' commits' }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'factory-eval-out-'));
  const reviews = mkdtempSync(join(tmpdir(), 'factory-eval-reviews-'));
  temps.push(out, reviews);
  writeFileSync(join(reviews, 'review-code.md'), REVIEW);
  process.env.FACTORY_EVAL_CLAUDE = `${process.execPath} ${fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))}`;
  process.env.FAKE_REVIEWS = reviews;
  const logs = [];
  try {
    const [path] = await main(['--runs', '1', '--cases', 'pr9-runner-progress', '--models', 'sonnet', '--out', out, '--keep'], { log: (l) => logs.push(l) });
    const result = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(result.variant, 'code-sonnet');
    const r = result.results[0].cases['pr9-runner-progress'];
    temps.push(r.repo);
    assert.equal(r.ok, true);
    assert.deepEqual(r.found, ['activity-cleanup-throws']);
    assert.equal(r.unmatched, 1);
    assert.deepEqual(result.summary.recall, { mean: 0.5, min: 0.5, max: 0.5 });
    assert.equal(result.summary.hits['stale-activity-never-expires'], 0);
    assert.match(logs.join('\n'), /Never found: stale-activity-never-expires/);

    // The job branch holds exactly the reviewed commit's change, and the worktree has
    // none of the (newer) installed factory.
    const worktree = join(r.repo, '.factory-worktrees', PR9.id);
    const files = (args) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim().split('\n').sort();
    const want = execFileSync('git', ['diff', '--name-only', PR9.base, PR9.head], { cwd: REPO, encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(files(['diff', '--name-only', 'main', 'HEAD']), want);
    assert.equal(readFileSync(join(worktree, 'template/factory/dashboard.html'), 'utf8'), show(PR9.head, 'template/factory/dashboard.html'));
    assert.ok(!existsSync(join(worktree, '.claude')));
    assert.match(readFileSync(join(r.repo, 'factory/jobs', PR9.id, 'round-1/round.md'), 'utf8'), /code/);
  } finally {
    delete process.env.FACTORY_EVAL_CLAUDE;
    delete process.env.FAKE_REVIEWS;
  }
});
