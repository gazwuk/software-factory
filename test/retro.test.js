import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  blockingCount, causesOf, lessonsOf, prepare, reportedJobs, retroDone, retroFacts, roundResponses, summarize,
} from '../template/.claude/skills/factory/retro.mjs';

const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo(jobs) {
  const root = mkdtempSync(join(tmpdir(), 'factory-retro-'));
  temps.push(root);
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/board.json'), JSON.stringify({ version: 1, jobs }));
  return root;
}

function files(root, id, map) {
  for (const [rel, text] of Object.entries(map)) {
    const path = join(root, 'factory/jobs', id, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(text));
  }
}

const REVIEW_CHANGES = `VERDICT: CHANGES

# Code review — 001-x, round 1

## Summary
Two problems.

## Blocking
1. **Unbounded loop** — \`src/a.js:12\`
   Why.
2. **Needless cache** — \`src/b.js:3\`

## Coverage
- Read: src/a.js

## Suggestions (non-blocking)
1. Rename it.
`;

test('blockingCount counts numbered items under Blocking, and nothing on a PASS', () => {
  assert.equal(blockingCount(REVIEW_CHANGES), 2, 'not the numbered suggestion');
  assert.equal(blockingCount('VERDICT: CHANGES\n\n1. Fix it.\n2. And this.\n'), 2, 'no Blocking heading');
  assert.equal(blockingCount('VERDICT: PASS\n\n## Blocking\nNone.\n'), 0);
  assert.equal(blockingCount(null), 0);
});

test('roundResponses reads the builder\'s answer to each finding', () => {
  const build = `# Build

## Changes
- **not a response** — fixed

## Round 1 response
- **code #1 Unbounded loop** — fixed in abc123: capped at 100.
- **code #2 Needless cache** — not changed: the spec rules out caching.
- **security #1 Token in log** – Fixed in def456.
- **human** — added the empty state.
- a plain line

## Round 2 response
- **ui #3 Contrast** — won't fix: matches the token.
`;
  const r = roundResponses(build);
  assert.deepEqual(Object.keys(r), ['1', '2']);
  assert.deepEqual(r[1].map((i) => [i.reviewer, i.finding, i.title, i.outcome]), [
    ['code', 1, 'Unbounded loop', 'fixed'],
    ['code', 2, 'Needless cache', 'disputed'],
    ['security', 1, 'Token in log', 'fixed'],
    ['human', null, '', 'other'],
  ]);
  assert.equal(r[1][1].note, 'not changed: the spec rules out caching.');
  assert.deepEqual(r[2].map((i) => i.outcome), ['disputed']);
  assert.deepEqual(roundResponses(null), {});
});

test('retroFacts counts rounds, check fixes, findings, disputes and who shipped it', () => {
  const id = '001-x';
  const root = repo([{
    id, title: 'X', stage: 'merged', round: 2, roundLimit: 2, decision: 'APPROVE', note: null,
    reviewers: ['code', 'ui'],
    rounds: [{ code: 'CHANGES', ui: 'PASS' }, { code: 'PASS', ui: 'SKIPPED' }],
    runner: { checkFixes: { 1: 1 } },
  }]);
  files(root, id, {
    'spec.md': '# X\n\n## Goal\nX.\n\n## Assumptions\n- Lists are short.\n- Dates are UTC.\n\n## Acceptance criteria\n1. X.\n',
    'build.md': '# Build\n\n## Round 1 response\n- **code #1 Unbounded loop** — fixed in abc.\n- **code #2 Needless cache** — not changed: out of scope.\n',
    'round-1/round.json': { round: 1, checks: { ok: true }, reviewers: { code: { run: true, model: 'sonnet' }, ui: { run: true, model: 'sonnet' } }, probe: { status: 'ran' } },
    'round-1/review-code.md': REVIEW_CHANGES,
    'round-1/review-ui.md': 'VERDICT: PASS\n',
    'round-2/round.json': { round: 2, checks: { ok: true }, reviewers: { code: { run: true, model: 'opus' }, ui: { run: false, model: null } } },
    'round-2/review-code.md': 'VERDICT: PASS\n',
    'decision.md': 'APPROVE\nReason: fine\n',
    'usage/a.json': { agent: 'builder', round: null, costUsd: 1 },
    'usage/b.json': { agent: 'review-code', round: 1, costUsd: 0.25 },
    'usage/c.json': { agent: 'review-code', round: 2, costUsd: 0.25 },
    'usage/d.json': { agent: 'retro', round: null, costUsd: 9 },
  });

  const f = retroFacts(root, id);
  assert.equal(f.clean, false);
  assert.deepEqual(f.why, [
    '2 review rounds',
    'code asked for changes in round 1 (2 blocking)',
    '1 check fix in round 1 (round-1/round.md has the last run)',
  ]);
  assert.equal(f.assumptions, 2);
  assert.equal(f.shippedBy, 'approver');
  assert.deepEqual(f.perRound[0].reviewers.code, { verdict: 'CHANGES', model: 'sonnet', blocking: 2, fixed: 1, disputed: 1 });
  assert.deepEqual(f.perRound[1].reviewers.ui, { verdict: 'SKIPPED' });
  assert.equal(f.perRound[0].probe, 'ran');
  assert.deepEqual(f.reviewers.code, { reviews: 2, changes: 1, blocking: 2, fixed: 1, disputed: 1, conceded: 1, held: 0 });
  assert.deepEqual(f.disputes, [{ round: 1, reviewer: 'code', finding: 2, title: 'Needless cache', reason: 'not changed: out of scope.', outcome: 'conceded' }]);
  assert.deepEqual(f.cost, { usd: 1.5, byRole: { builder: 1, reviewers: 0.5 }, activeSeconds: 0 }, 'the retro\'s own cost is left out');
});

test('without runner check-fix counts, they come from builder runs less the round response', () => {
  const id = '002-y';
  const root = repo([{ id, title: 'Y', stage: 'merged', round: 1, decision: 'APPROVE', reviewers: ['code'] }]);
  files(root, id, {
    'build.md': '# Build\n',
    'round-1/review-code.md': 'VERDICT: PASS\n',
    'usage/a.json': { agent: 'builder', round: null },
    'usage/b.json': { agent: 'builder', round: 1 },
    'usage/c.json': { agent: 'builder', round: 1 },
  });
  assert.equal(retroFacts(root, id).perRound[0].checkFixes, 2);
});

test('a clean job, a human ship, escalations and reworks', () => {
  const root = repo([
    { id: '001-a', title: 'A', stage: 'merged', round: 1, decision: 'APPROVE', reviewers: ['code'] },
    { id: '002-b', title: 'B', stage: 'merged', round: 2, decision: 'ESCALATE', note: 'touches auth', reviewers: ['code'] },
  ]);
  files(root, '001-a', { 'round-1/review-code.md': 'VERDICT: PASS\n', 'decision.md': 'APPROVE\nReason: ok\n' });
  const clean = retroFacts(root, '001-a');
  assert.deepEqual([clean.clean, clean.why], [true, []]);

  files(root, '002-b', {
    'build.md': '# Build\n\n## Round 1 response\n- **human** — did it.\n',
    'round-1/review-code.md': 'VERDICT: PASS\n',
    'round-1/human.md': '# Human feedback\n\nAlso do Z.\n',
    'round-1/decision.md': 'ESCALATE\nReason: missed Z\n',
    'round-2/review-code.md': 'VERDICT: PASS\n',
    'decision.md': 'ESCALATE\nReason: touches auth\n',
  });
  const b = retroFacts(root, '002-b');
  assert.equal(b.reworks, 1);
  assert.equal(b.shippedBy, 'human');
  assert.deepEqual(b.escalations, [{ round: 1, reason: 'missed Z' }, { round: null, reason: 'touches auth' }]);
  assert.deepEqual(b.why, [
    '2 review rounds',
    'a human sent the job back after round 1 (round-1/human.md)',
    'the approver escalated: touches auth',
    'shipped by a human (touches auth)',
  ]);
  assert.equal(b.perRound[0].escalated, true);
});

test('retroDone matches retro.json to the job\'s stage and round, and wants retro.md unless clean', () => {
  const job = { id: '001-a', title: 'A', stage: 'needs-human', round: 1, decision: null, note: 'checks', reviewers: ['code'] };
  const root = repo([job]);
  files(root, '001-a', { 'round-1/review-code.md': 'VERDICT: PASS\n' });
  assert.equal(retroDone(root, job), false);
  prepare(root, '001-a');
  assert.equal(retroDone(root, job), false, 'not clean, and no retro.md yet');
  files(root, '001-a', { 'retro.md': '# Retro\n\n## Causes\n- `flaky-check` — x\n' });
  assert.equal(retroDone(root, job), true);
  assert.equal(retroDone(root, { ...job, stage: 'merged' }), false, 'the job moved on since');

  // When it ships, the facts are counted again and the needs-human retro.md goes.
  prepare(root, '001-a', { stage: 'merged' });
  assert.ok(!existsSync(join(root, 'factory/jobs/001-a/retro.md')));
  assert.equal(retroDone(root, { ...job, stage: 'merged' }), false);
});

test('prepare leaves retro.json alone when only the time would change, and can stand in a stage', () => {
  const job = { id: '001-a', title: 'A', stage: 'approval', round: 1, decision: 'APPROVE', reviewers: ['code'] };
  const root = repo([job]);
  files(root, '001-a', { 'round-1/review-code.md': 'VERDICT: PASS\n' });
  const path = join(root, 'factory/jobs/001-a/retro.json');
  const first = prepare(root, '001-a', { stage: 'merged' });
  assert.deepEqual([first.stage, first.shippedBy, first.clean], ['merged', 'approver', true]);
  writeFileSync(path, readFileSync(path, 'utf8').replace(first.preparedAt, '2000-01-01T00:00:00Z'));
  const again = prepare(root, '001-a', { stage: 'merged' });
  assert.equal(again.preparedAt, '2000-01-01T00:00:00Z');
  assert.match(readFileSync(path, 'utf8'), /2000-01-01T00:00:00Z/, 'not rewritten');
  assert.equal(prepare(root, '001-a').stage, 'approval', 'without a stand-in, the board\'s stage');
});

test('causesOf and lessonsOf read only known tags and bracketed targets', () => {
  const md = `# Retro — 001

Words.

## Causes
- \`spec-gap\` — no empty state (round-1/review-ux.md #2)
- \`made-up\` — ignored
- missing-check — lint not run
* \`reviewer-noise\`: cache finding

## Lessons
- [project.md] Conventions: "Lists have empty states."
- [agent:builder] Run every check.
- not a lesson
`;
  assert.deepEqual(causesOf(md).map((c) => c.tag), ['spec-gap', 'missing-check', 'reviewer-noise']);
  assert.equal(causesOf(md)[0].text, 'no empty state (round-1/review-ux.md #2)');
  assert.deepEqual(lessonsOf(md), [
    { target: 'project.md', text: 'Conventions: "Lists have empty states."' },
    { target: 'agent:builder', text: 'Run every check.' },
  ]);
  assert.deepEqual(causesOf(''), []);
});

test('summarize tallies causes across jobs and marks the ones no report has covered', () => {
  const jobs = ['001-a', '002-b', '003-c'].map((id) => ({ id, title: id, stage: 'merged', round: 2, decision: 'APPROVE', reviewers: ['code'] }));
  const root = repo([...jobs, { id: '004-d', title: 'd', stage: 'review', round: 1, reviewers: ['code'] }]);
  const retro = (causes) => `# Retro\n\n## Causes\n${causes.map((c) => `- \`${c}\` — because\n`).join('')}\n## Lessons\n- [project.md] Add a line.\n`;
  jobs.forEach((j, i) => {
    files(root, j.id, {
      'round-1/review-code.md': REVIEW_CHANGES,
      'build.md': '# B\n\n## Round 1 response\n- **code #2 Needless cache** — not changed: no.\n',
      'round-2/review-code.md': 'VERDICT: PASS\n',
    });
    prepare(root, j.id);
    files(root, j.id, { 'retro.md': retro(i === 2 ? ['flaky-check'] : ['spec-gap', 'missing-check']) });
  });
  files(root, '004-d', { 'retro.json': { job: '004-d' } }); // active: left out
  mkdirSync(join(root, 'factory/retros'));
  writeFileSync(join(root, 'factory/retros/2026-11-01.md'), '# Retro report\n\nJobs: 001-a, 999-gone\n');
  assert.deepEqual([...reportedJobs(root)], ['001-a', '999-gone']);

  const out = summarize(root);
  assert.match(out, /^# Retro summary\n\n3 jobs, 2 not in an earlier report: /);
  assert.match(out, /\| `missing-check` \| 2 \| 1 \| 0\d\d-., 0\d\d-. \|/);
  assert.match(out, /\| `flaky-check` \| 1 \| 1 \| 003-c \|/);
  assert.match(out, /### project\.md\n\n- \(\d{3}-.(, new)?\) Add a line\./);
  assert.match(out, /\| code \| 6 \| 3 \| 6 \| 3 \| 3 \|/, 'reviews, changes, blocking, disputed, conceded');
  assert.match(out, /\| 001-a \| merged \| 2 \| 0 \| 0 \| approver \| \$0\.00 \| no \|/);
  assert.doesNotMatch(out, /004-d/);
  assert.equal(summarize(root, { last: 1 }).match(/^\| 00\d-. \| merged/gm).length, 1);
  assert.match(summarize(repo([])), /No retros yet/);
});
