import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, compareWithBase, findingsOf, parseScreens, planVisits, renderProbe, tally } from '../template/.claude/skills/factory/probe.mjs';

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
  assert.equal(planVisits(rows, { ...DEFAULTS, maxVisits: 5 }).dropped, 2 * 3 * 2 - 5);
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
  assert.match(md, /\| 1 \| `\/a` \(default\) \| 320px light, 768px light \| overflow \| too wide — `table` \|/);
  assert.match(md, /- \/a \(loading\): no URL/);
  assert.match(md, /1\. button "Go" `button` — \*\*focus not visible\*\*/);
  assert.doesNotMatch(md, /## Warnings/);
});
