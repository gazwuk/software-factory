import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, compareWithBase, depChanges, findingsOf, laneOf, numbered, parseScreens, planVisits, probeIds, redact, renderProbe, reviewGaps, startupVisit, tabStep, tally } from '../template/.claude/skills/factory/probe.mjs';

const SPEC = `# Billing

## Screens
| Screen | State | How to reach it |
|---|---|---|
| \`/settings/billing\` | default | Signed in as the seeded user. |
| \`/settings/billing\` | \`empty\` | A user with no cards: \`/settings/billing?cards=0\` |
| \`/settings/billing\` | error | \`/api/cards\` mocked to 500 in billing.test.tsx |
| \`CardList\` in \`src/CardList.tsx\` | default | Rendered by the page. |

## Acceptance criteria
1. AC1 — x
`;

test('parseScreens reads routes, states and URLs from the Screens table', () => {
  const rows = parseScreens(SPEC);
  assert.deepEqual(rows.map((r) => [r.state, r.path, r.reason]), [
    ['default', '/settings/billing', null],
    ['empty', '/settings/billing?cards=0', null],
    // An API path in How isn't the screen's URL.
    ['error', null, 'no URL in "How to reach it"'],
    ['default', null, 'not a route'],
  ]);
  assert.deepEqual(parseScreens('# x\n\n## Screens\nNone — no user interface.\n'), []);
  assert.deepEqual(parseScreens('# x\n\n## Goal\ny\n'), []);
});

test('a non-default state with no URL is not visited', () => {
  const rows = parseScreens('## Screens\n| Screen | State | How to reach it |\n|---|---|---|\n| `/a` | loading | slow network |\n');
  assert.equal(rows[0].path, null);
  assert.match(rows[0].reason, /no URL/);
});

test('planVisits crosses screens with viewports and themes, and tab-walks once each', () => {
  const rows = parseScreens(SPEC).filter((r) => r.state !== 'error');
  const { visits, dropped } = planVisits(rows, { ...DEFAULTS, viewports: [1280, 320], themes: ['light', { name: 'hc', colorScheme: 'dark', init: 'x()' }] });
  assert.equal(visits.length, 2 * 2 * 2);
  assert.equal(dropped, 0);
  assert.deepEqual(visits.filter((v) => v.tabWalk).map((v) => `${v.path} ${v.width} ${v.theme.name}`), [
    '/settings/billing 1280 light', '/settings/billing?cards=0 1280 light',
  ]);
  assert.equal(visits.find((v) => v.theme.name === 'hc').theme.init, 'x()');
  const capped = planVisits(rows, { ...DEFAULTS, maxVisits: 5 });
  assert.equal(capped.dropped, 2 * 3 * 2 - 5);
  // The first state keeps 5 of its 6 visits; the second loses all of them.
  assert.deepEqual(capped.unvisited.map((u) => `${u.path} ${u.state}: ${u.reason}`), [
    '/settings/billing?cards=0 empty: over `ui.maxVisits` (5)',
  ]);
  assert.deepEqual(planVisits(rows, DEFAULTS).unvisited, []);
});

test('findingsOf sorts measurements into blocking failures and warnings', () => {
  const f = findingsOf({
    status: 500,
    pageErrors: ['TypeError: x is undefined'],
    overflow: { width: 320, scrollWidth: 600, offenders: ['table'] },
    axe: [
      { id: 'color-contrast', impact: 'serious', help: 'contrast', nodes: [{ target: 'p', summary: '1.9:1' }] },
      { id: 'region', impact: 'moderate', help: 'landmarks', nodes: [{ target: 'div', summary: '' }] },
    ],
    consoleErrors: ['boom'],
    failedRequests: ['GET /api → 500'],
    cls: 0.25,
    tab: { stops: [{ selector: 'button', role: 'button', name: 'Go', visible: false }, { selector: 'a', visible: true }], trap: 'input' },
  }, 'default');
  const by = (level) => f.filter((x) => x.level === level).map((x) => x.rule || x.kind).sort();
  assert.deepEqual(by('fail'), ['color-contrast', 'http-status', 'overflow', 'page-error']);
  assert.deepEqual(by('warn'), ['console-error', 'focus-not-visible', 'focus-trap', 'layout-shift', 'region', 'request-failed']);
  // An error state is expected to return an error status.
  assert.equal(findingsOf({ status: 500 }, 'error')[0].level, 'warn');
});

const visitWith = (key, findings) => ({
  key, path: key.split('|')[0], state: 'default', width: Number(key.split('|')[2]), theme: { name: 'light' },
  screen: 'x', status: 200, cls: 0, screenshot: null, tab: null, findings,
});

test('only failures the merge base lacks block; without a base they are unverified', () => {
  const head = () => [
    visitWith('/a|default|320|light', [
      { kind: 'overflow', level: 'fail', target: 't', message: 'm' },
      { kind: 'axe', rule: 'color-contrast', target: 'p', level: 'fail', message: 'c' },
      { kind: 'console-error', level: 'warn', message: 'w' },
    ]),
    visitWith('/a|default|1280|light', [{ kind: 'axe', rule: 'color-contrast', target: 'p', level: 'fail', message: 'c' }]),
  ];
  const base = [
    visitWith('/a|default|320|light', [{ kind: 'axe', rule: 'color-contrast', target: 'p', level: 'fail', message: 'c' }]),
    visitWith('/a|default|1280|light', [{ kind: 'axe', rule: 'color-contrast', target: 'p', level: 'fail', message: 'c' }]),
  ];
  const compared = head();
  compareWithBase(compared, base);
  assert.deepEqual(compared[0].findings.map((f) => f.origin), ['new', 'pre-existing', undefined]);
  // Counted once per screen and state, whatever the viewport.
  assert.deepEqual(tally(compared), { failures: 1, preExisting: 1, unverified: 0, warnings: 1 });

  const alone = head();
  compareWithBase(alone, null);
  assert.deepEqual(tally(alone), { failures: 0, preExisting: 0, unverified: 2, warnings: 1 });
});

test('renderProbe reports skips and groups findings by screen', () => {
  assert.match(renderProbe({ id: '001-x', round: 1, status: 'skipped', reason: 'no ui.serve.' }), /\*\*Skipped:\*\* no ui\.serve\./);

  const visits = [
    visitWith('/a|default|320|light', [{ kind: 'overflow', level: 'fail', origin: 'new', target: 'table', message: 'too wide' }]),
    visitWith('/a|default|768|light', [{ kind: 'overflow', level: 'fail', origin: 'new', target: 'table', message: 'too wide' }]),
  ];
  visits[0].tab = { stops: [{ role: 'button', name: 'Go', selector: 'button', visible: false }], trap: null, complete: true };
  const md = renderProbe({
    id: '001-x', round: 2, status: 'ran', sha: 'abc', serve: 'npm start', browser: '130', axe: '4.10',
    visits, unreached: [{ screen: '/a', state: 'loading', reason: 'no URL in "How to reach it"' }], dropped: 0,
  });
  assert.match(md, /\*\*Result:\*\* 1 new failure\(s\)/);
  assert.match(md, /## Failures \(block the round\)/);
  assert.match(md, /\| F1 \| ui \| `\/a` \(default\) \| 320px light, 768px light \| overflow \| too wide — `table` \|/);
  assert.match(md, /- N1 \(ux\): \/a \(loading\): no URL/);
  assert.match(md, /1\. button "Go" `button` — \*\*focus not visible\*\*/);
  assert.doesNotMatch(md, /## Warnings/);
});

test('laneOf gives looks to ui and whether it works to ux', () => {
  assert.equal(laneOf({ kind: 'overflow' }), 'ui');
  assert.equal(laneOf({ kind: 'focus-not-visible' }), 'ui');
  assert.equal(laneOf({ kind: 'console-error' }), 'ux');
  assert.equal(laneOf({ kind: 'focus-trap' }), 'ux');
  assert.equal(laneOf({ kind: 'axe', rule: 'color-contrast', cats: ['cat.color'] }), 'ui');
  assert.equal(laneOf({ kind: 'axe', rule: 'target-size', cats: ['cat.sensory-and-visual-cues'] }), 'ui');
  assert.equal(laneOf({ kind: 'axe', rule: 'button-name', cats: ['cat.name-role-value'] }), 'ux');
  assert.equal(laneOf({ kind: 'axe', rule: 'label', cats: ['cat.forms'] }), 'ux');
});

function probeRun() {
  const shot = (v) => `probe/a-${v.state}-${v.width}-light.png`;
  const visits = [
    { ...visitWith('/a|default|320|light', [
      { kind: 'overflow', level: 'fail', origin: 'unverified', target: 't', message: 'wide' },
      { kind: 'layout-shift', level: 'warn', message: 'CLS 0.2' },
      { kind: 'console-error', level: 'warn', message: 'boom' },
    ]) },
    { ...visitWith('/a|default|1280|light', [{ kind: 'console-error', level: 'warn', message: 'boom' }]), tab: { stops: [] } },
  ];
  for (const v of visits) v.screenshot = shot(v);
  return { status: 'ran', visits, unreached: [{ screen: '/a', state: 'error', reason: 'no URL' }] };
}

test('numbered gives each probe item a stable ID and lane', () => {
  assert.deepEqual(numbered(probeRun()).map((x) => `${x.id} ${x.lane}`), ['U1 ui', 'W1 ui', 'W2 ux', 'N1 ux']);
});

test('reviewGaps lists the probe items and screenshots a review leaves out', () => {
  const probe = probeRun();
  const both = ['ui', 'ux'];
  const ui = [
    '# UI review', '', '## Probe findings', '- U1 — blocking #1', '', '## Coverage',
    '- Screens viewed: probe/a-default-320-light.png', '',
  ].join('\n');
  assert.deepEqual(reviewGaps({ probe, review: ui, name: 'ui', running: both }), ['W1', 'probe/a-default-1280-light.png']);
  // IDs count only under Probe findings; W10 doesn't answer W1.
  assert.deepEqual(reviewGaps({ probe, review: ui.replace('U1 —', 'W10, U1 —') + '\nW1 mentioned elsewhere', name: 'ui', running: both })[0], 'W1');

  // ux answers its own items and only views the Tab-order screenshots.
  const ux = '## Probe findings\n- W2 — not a defect: dev-only warning\n- N1 — covered by `a.test.tsx` "shows the error"\n\n## Coverage\n- a-default-1280-light.png\n';
  assert.deepEqual(reviewGaps({ probe, review: ux, name: 'ux', running: both }), []);
  // A range answers every item in it.
  const ranged = ui.replace('- U1 — blocking #1', '- U1 — blocking #1\n- W1–W2 — blocking #2');
  assert.deepEqual(reviewGaps({ probe, review: ranged, name: 'ui', running: ['ui'] }).filter((x) => !x.endsWith('.png')), ['N1']);
  // With ux skipped this round, ui owns its lane too.
  assert.deepEqual(reviewGaps({ probe, review: '', name: 'ui', running: ['ui'] }).slice(0, 4), ['U1', 'W1', 'W2', 'N1']);
  // Nothing is owed when the probe didn't run.
  assert.deepEqual(reviewGaps({ probe: { status: 'skipped' }, review: '', name: 'ui', running: both }), []);
});

test('probeIds reads single IDs and expands ranges', () => {
  const ids = (text) => [...probeIds(text)];
  assert.deepEqual(ids('W1–W4 — blocking #2'), ['W1', 'W2', 'W3', 'W4']);
  assert.deepEqual(ids('F5-F7, F17 - F19; W2-4'), ['F5', 'F6', 'F7', 'F17', 'F18', 'F19', 'W2', 'W3', 'W4']);
  assert.deepEqual(ids('U1 — not a defect; W10, N2'), ['U1', 'W10', 'N2']);
  assert.deepEqual(ids('AC2, UF1, W1x, W3–U4'), ['W3', 'U4']);
});

test('redact masks credentials, tokens and personal data, and keeps what locates a problem', () => {
  const cases = [
    ['GET https://cdn.example.com/u/a.png?X-Amz-Signature=abc&X-Amz-Credential=k#t → 403', 'GET https://cdn.example.com/u/a.png?… → 403'],
    ['fetch /api/me?access_token=s3cr3t&page=2 failed', 'fetch /api/me?access_token=…&page=2 failed'],
    ['Authorization: Bearer abc.def-ghi rejected', 'Authorization: Bearer … rejected'],
    ['bad jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', 'bad jwt …'],
    ['no account for jane.doe+x@example.co.uk', 'no account for …@…'],
    ['DATABASE_URL=postgres://admin:hunter2@db:5432/app', 'DATABASE_URL=postgres://…@db:5432/app'],
    ['GET http://localhost:3000/s/a8f5f167f44f4964e6c998dee827110c/next → 401', 'GET http://localhost:3000/s/…/next → 401'],
  ];
  for (const [raw, masked] of cases) assert.equal(redact(raw), masked);
  for (const kept of [
    'GET http://localhost:5173/api/orders/1042 → 500',
    'GET http://localhost:5173/assets/main.3f9a8b7c6d5e4f3a2b1c0d.js → 404',
    "TypeError: Cannot read properties of undefined (reading 'id')",
  ]) assert.equal(redact(kept), kept);
});

test('an app that won\'t start blocks if the base starts, and is unverified if it doesn\'t', () => {
  const broke = { status: 'ran', visits: [startupVisit('SyntaxError: x', true)], unreached: [] };
  assert.deepEqual(tally(broke.visits), { failures: 1, preExisting: 0, unverified: 0, warnings: 0 });

  // No base to compare with: it doesn't block, but the ux reviewer must answer it.
  const unknown = { status: 'ran', visits: [startupVisit('SyntaxError: x', false)], unreached: [] };
  assert.deepEqual(tally(unknown.visits), { failures: 0, preExisting: 0, unverified: 1, warnings: 0 });
  assert.match(renderProbe(unknown), /## Unverified[\s\S]*\| U1 \| ux \| `\/` \(start\) \| startup \| app-start \| the app didn't start: SyntaxError: x/);
  const both = ['ui', 'ux'];
  assert.deepEqual(reviewGaps({ probe: unknown, review: '', name: 'ux', running: both }), ['U1']);
  assert.deepEqual(reviewGaps({ probe: unknown, review: '## Probe findings\n- U1 — blocking #1\n', name: 'ux', running: both }), []);
  assert.deepEqual(reviewGaps({ probe: unknown, review: '', name: 'ui', running: both }), []);
});

test('depChanges sees dependency changes before they are committed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir }).toString().trim();
  git('init', '-q');
  mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'package.json'), '{}\n');
  writeFileSync(join(dir, 'app.js'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'app.js'), 'y\n');
  assert.deepEqual(depChanges(dir, base), []);
  writeFileSync(join(dir, 'package.json'), '{"dependencies":{"a":"1"}}\n');
  writeFileSync(join(dir, 'web/yarn.lock'), '# new\n');
  assert.deepEqual(depChanges(dir, base).sort(), ['package.json', 'web/yarn.lock']);
  git('add', '.');
  git('commit', '-qm', 'deps');
  assert.deepEqual(depChanges(dir, base).sort(), ['package.json', 'web/yarn.lock']);
});

test('tabStep catches a trap on the first stop, and ends when Tab leaves or comes round', () => {
  const a = { id: 1, selector: 'input' };
  const b = { id: 2, selector: 'button' };
  // A trap on the first stop: the second press stays on it.
  assert.equal(tabStep([a], a), 'trap');
  assert.equal(tabStep([a, b], b), 'trap');
  // A lone stop, then focus leaves the page (Chromium focuses the body).
  assert.equal(tabStep([], a), 'next');
  assert.equal(tabStep([a], null), 'complete');
  assert.equal(tabStep([a, b], a), 'complete');
  assert.equal(tabStep([], null), 'complete');
  // Focus moving inside an iframe can't be followed, and isn't a trap.
  const frame = { id: 3, selector: 'iframe', frame: true };
  assert.equal(tabStep([a, frame], frame), 'frame');
});
