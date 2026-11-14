import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { main, summarize } from './evals/run.mjs';
import { blockingFindings, citations, scoreReview, scoreRun, spread } from './evals/score.mjs';

const EVALS = fileURLToPath(new URL('./evals/', import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(EVALS, 'ui/defects.json'), 'utf8'));
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test('every planted defect and control points at the lines it describes', () => {
  const spans = [];
  for (const item of [...FIXTURE.defects, ...FIXTURE.controls]) {
    for (const loc of item.locations) {
      const lines = readFileSync(join(EVALS, 'ui/change', loc.file), 'utf8').split('\n');
      const [from, to] = loc.lines;
      assert.ok(from >= 1 && to >= from && to <= lines.length, `${item.id}: ${loc.file}:${from}-${to} is outside the file`);
      assert.ok(lines.slice(from - 1, to).join('\n').includes(loc.text), `${item.id}: "${loc.text}" isn't in ${loc.file}:${from}-${to}`);
      for (const s of spans) {
        const overlaps = s.file === loc.file && from <= s.to && to >= s.from;
        assert.ok(!overlaps || s.id === item.id, `${item.id} and ${s.id} overlap in ${loc.file}`);
      }
      spans.push({ id: item.id, file: loc.file, from, to });
    }
  }
});

test('the fixture covers both lanes, the probe-measurable kinds and the judgement kinds', () => {
  const ids = (pick) => FIXTURE.defects.filter(pick).map((d) => d.id);
  assert.ok(ids((d) => d.lane === 'ui').length >= 4);
  assert.ok(ids((d) => d.lane === 'ux').length >= 4);
  const probed = FIXTURE.defects.filter((d) => d.probe).map((d) => d.probe.rule || d.probe.kind);
  for (const kind of ['overflow', 'color-contrast', 'button-name', 'focus-not-visible', 'target-size']) assert.ok(probed.includes(kind), kind);
  for (const id of ['ux-error', 'ux-confirm', 'ux-flow-test']) assert.ok(ids((d) => d.kind === 'judgement').includes(id), id);
  assert.ok(FIXTURE.controls.length >= 3);
});

test('citations reads file:line, ranges, probe IDs and screenshots', () => {
  const c = citations('See `styles/orders.css:36`, /tmp/wt/js/orders.js:60-66 and orders.html:21 – 23; F2, W10 and probe/orders-default-320-light.png. Not AC2 or UF1.');
  assert.deepEqual(c.lines, [
    { file: 'styles/orders.css', from: 36, to: 36 },
    { file: '/tmp/wt/js/orders.js', from: 60, to: 66 },
    { file: 'orders.html', from: 21, to: 23 },
  ]);
  assert.deepEqual(c.probe, ['F2', 'W10']);
  assert.deepEqual(c.shots, ['orders-default-320-light.png']);
});

// A probe.json as probe.mjs writes it, cut down to what scoring reads.
const PROBE = {
  status: 'ran', unreached: [],
  visits: [
    {
      key: '/orders|default|320|light', path: '/orders', state: 'default', width: 320, theme: { name: 'light' },
      screenshot: 'probe/orders-default-320-light.png',
      findings: [
        { kind: 'overflow', level: 'fail', origin: 'new', target: '#orders > table.orders-table', message: 'page is 736px wide' },
        { kind: 'axe', rule: 'button-name', cats: ['cat.name-role-value'], level: 'fail', origin: 'new', target: 'tr > .icon-btn[data-action="delete"]', message: 'Buttons must have discernible text' },
      ],
    },
    {
      key: '/orders|default|1280|light', path: '/orders', state: 'default', width: 1280, theme: { name: 'light' },
      screenshot: 'probe/orders-default-1280-light.png',
      findings: [
        { kind: 'focus-not-visible', level: 'warn', target: 'td.actions > button.icon-btn:nth-of-type(2)', message: 'no visible change' },
        { kind: 'focus-not-visible', level: 'warn', target: '#details-close', message: 'no visible change' },
      ],
    },
    {
      key: '/orders?state=empty|empty|1280|light', path: '/orders?state=empty', state: 'empty', width: 1280, theme: { name: 'light' },
      screenshot: 'probe/orders-state-empty-empty-1280-light.png', findings: [],
    },
  ],
};
// F1 overflow, F2 button-name, W1 focus on an icon button, W2 focus on Close.

const UI_REVIEW = `VERDICT: CHANGES
# UI review — 001-orders-page, round 1

## Summary
Four problems.

## Blocking
1. **Table overflows at 320px** — F1
   Problem: the page scrolls sideways.
   Required change: wrap the table in a scroll container.
2. **Literal colour** — \`styles/orders.css:2\`
   Problem: #333 where \`--color-text\` exists (\`styles/tokens.css:3\`).
3. **Icon buttons hide focus**
   Problem: no focus indicator.
4. **Pill padding** — \`styles/orders.css:55\`
   Problem: wrongly called a literal.
5. **Close has no focus style** — W2
   Problem: …

## Coverage
- Read: styles/orders.css

## Probe findings
- W1 — blocking #3
- W2 — blocking #5
`;

const UX_REVIEW = `VERDICT: CHANGES
# UX review — 001-orders-page, round 1

## Blocking
1. **Delete has no confirmation** — \`/tmp/x/.factory-worktrees/001-orders-page/js/orders.js:61\`
   Problem: one press deletes the order.
2. **Empty state has no next step** — probe/orders-state-empty-empty-1280-light.png
   Problem: it only says "No orders."
3. **Unnamed delete button** — F2
4. **Small heading on the blank list** — orders-state-empty-empty-1280-light.png
   Problem: the heading looks small.

## Coverage
- Read: js/orders.js
`;

test('blockingFindings numbers each finding and links the probe items it answers', () => {
  const findings = blockingFindings(UI_REVIEW);
  assert.deepEqual(findings.map((f) => f.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(findings[2].cites.probe, ['W1']);
  assert.match(findings[1].text, /tokens\.css:3/);
  assert.deepEqual(blockingFindings('VERDICT: PASS\n\n## Blocking\nNone.\n'), []);
});

test('scoreReview counts defects found by line, probe ID and screenshot, and false positives on controls', () => {
  const ui = scoreReview({ review: UI_REVIEW, lane: 'ui', fixture: FIXTURE, probe: PROBE });
  assert.equal(ui.verdict, 'CHANGES');
  assert.deepEqual(ui.found.sort(), ['ui-focus', 'ui-overflow', 'ui-token']);
  assert.equal(ui.blocking, 5);
  assert.equal(ui.matched, 3);
  assert.equal(ui.precision, 3 / 5);
  assert.equal(ui.recall, 3 / 5);
  assert.equal(ui.falsePositives, 1);
  assert.deepEqual(ui.controlsFlagged, ['c-pill-tokens']);

  const ux = scoreReview({ review: UX_REVIEW, lane: 'ux', fixture: FIXTURE, probe: PROBE });
  assert.deepEqual(ux.found.sort(), ['ux-confirm', 'ux-empty', 'ux-name']);
  assert.equal(ux.recall, 3 / 7);
  assert.equal(ux.matched, 3, 'a screenshot without the defect\'s keywords finds nothing');

  // Without the probe, probe IDs and screenshots point at nothing.
  const blind = scoreReview({ review: UX_REVIEW, lane: 'ux', fixture: FIXTURE, probe: null });
  assert.deepEqual(blind.found, ['ux-confirm']);
});

test('scoreRun combines the reviewers and says what the probe pointed at', () => {
  const run = scoreRun({ reviews: { ui: UI_REVIEW, ux: UX_REVIEW }, fixture: FIXTURE, probe: PROBE });
  assert.equal(run.combined.found.length, 6);
  assert.equal(run.combined.recall, 6 / 12);
  assert.deepEqual(run.combined.byLane, { ui: 3 / 5, ux: 3 / 7 });
  assert.deepEqual(run.probe.flagged, ['ui-overflow', 'ui-focus', 'ux-name']);
  assert.equal(scoreRun({ reviews: { ui: 'VERDICT: PASS\n' }, fixture: FIXTURE, probe: null }).probe.status, 'off');
});

test('spread and summarize report the mean and range across runs', () => {
  assert.deepEqual(spread([0.5, null, 1]), { mean: 0.75, min: 0.5, max: 1 });
  assert.equal(spread([null]), null);
  const run = (recall, found) => ({
    reviewers: {
      ui: { recall, precision: 1, falsePositives: 0, cost: 0.5, tokens: 100, checkReview: true },
      ux: { recall: 0, precision: null, falsePositives: 1, cost: 0.25, tokens: 50, checkReview: false },
    },
    combined: { recall, found },
    probe: { recall: 0 },
  });
  const s = summarize([run(0.2, ['ui-token']), run(0.6, ['ui-token', 'ux-name'])], FIXTURE);
  assert.deepEqual(s.reviewers.ui.recall, { mean: 0.4, min: 0.2, max: 0.6 });
  assert.equal(s.reviewers.ux.precision, null);
  assert.equal(s.reviewers.ux.checkReview, '0/2');
  assert.equal(s.defects['ui-token'], 2);
  assert.equal(s.defects['ux-name'], 1);
});

test('eval:reviewers runs end to end (fake agents, no probe) and writes scored results', async () => {
  const out = mkdtempSync(join(tmpdir(), 'factory-eval-out-'));
  const reviews = mkdtempSync(join(tmpdir(), 'factory-eval-reviews-'));
  temps.push(out, reviews);
  mkdirSync(reviews, { recursive: true });
  writeFileSync(join(reviews, 'review-ui.md'), UI_REVIEW);
  writeFileSync(join(reviews, 'review-ux.md'), UX_REVIEW);
  process.env.FACTORY_EVAL_CLAUDE = `${process.execPath} ${fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))}`;
  process.env.FAKE_REVIEWS = reviews;
  const logs = [];
  try {
    const [path] = await main(['--runs', '2', '--probe', 'off', '--models', 'sonnet', '--out', out], { log: (l) => logs.push(l) });
    const result = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(result.variant, 'probe-off-sonnet');
    assert.equal(result.results.length, 2);
    const ui = result.results[0].reviewers.ui;
    assert.deepEqual(ui.found.sort(), ['ui-token'], 'without the probe only the file:line citation counts');
    assert.equal(ui.checkReview, true);
    assert.ok(ui.cost > 0);
    assert.equal(result.results[0].probe.status, 'off');
    assert.deepEqual(result.summary.reviewers.ui.recall, { mean: 0.2, min: 0.2, max: 0.2 });
    assert.match(logs.join('\n'), /\| ui \| 20% \|/);
  } finally {
    delete process.env.FACTORY_EVAL_CLAUDE;
    delete process.env.FAKE_REVIEWS;
  }
});
