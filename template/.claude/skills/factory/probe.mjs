#!/usr/bin/env node
// UI probe: serves the job's worktree, opens every screen and state spec.md lists at
// each viewport and theme, and measures them, so UI and UX reviews start from facts
// rather than a diff.
//
//   node .claude/skills/factory/probe.mjs <job-id> [round]
//   node .claude/skills/factory/probe.mjs check-review <job-id> <round> <reviewer>
//
// With a round (how round.mjs runs it) it writes factory/jobs/<id>/round-<N>/probe.md,
// probe.json and probe/*.png. Without one (the builder, before committing) it writes
// to a temp folder. Either way it prints one line of JSON.
//
// It needs config.ui.serve, and Playwright and axe-core installed in the repo. Without
// them it reports "skipped" and the reviewers work from the diff alone. It blocks only
// what it can show the change introduced: a failure is checked against the merge base
// and doesn't block if the base has it too.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareWorktree, unlinkFiles } from './worktree.mjs';

export const DEFAULTS = {
  serve: '',
  url: 'http://localhost:{port}',
  readyTimeout: 120,
  viewports: [320, 768, 1280],
  themes: ['light', 'dark'],
  storageState: null,
  maxVisits: 60,
  tabStops: 30,
};

const VIEWPORT_HEIGHT = 800;
const MAX_SHOT_HEIGHT = 4000;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const AXE_NODES = 5;
const CLS_LIMIT = 0.1;
const DEP_FILES = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

// ---------- the spec's Screens table ----------

/**
 * Reads the `## Screens` table from spec.md. Each row is a screen and state; it can be
 * visited when the screen is a route (`/path`). The visit uses the first backticked
 * URL in "How to reach it" that starts with the route (so an API path mentioned there
 * isn't opened), else the route itself for the `default` state.
 */
export function parseScreens(spec) {
  const m = /^## Screens[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(spec);
  if (!m) return [];
  const rows = [];
  for (const line of m[1].split('\n')) {
    if (!/^\s*\|/.test(line) || /^\s*\|[\s|:-]+\|\s*$/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length < 3 || /^screen$/i.test(cells[0])) continue;
    const [screen, rawState, how] = cells;
    const state = rawState.replace(/`/g, '').trim().toLowerCase();
    const route = /`(\/[^`]*)`/.exec(screen)?.[1] ?? null;
    const viaHow = route ? [...how.matchAll(/`(\/[^`]*)`/g)].map((x) => x[1]).find((u) => u.startsWith(route)) ?? null : null;
    let path = null;
    let reason = null;
    if (!route) reason = 'not a route';
    else if (viaHow) path = viaHow;
    else if (state === 'default') path = route;
    else reason = 'no URL in "How to reach it"';
    rows.push({ screen: screen.replace(/`/g, ''), state, path, reason });
  }
  return rows;
}

const themeOf = (t) => (typeof t === 'string'
  ? { name: t, colorScheme: t === 'dark' ? 'dark' : 'light', init: null }
  : { name: t.name, colorScheme: t.colorScheme || 'light', init: t.init || null });

/**
 * Every visit: each screen and state at each viewport in each theme. The tab walk runs
 * once per screen and state, at the widest viewport in the first theme.
 */
export function planVisits(rows, ui) {
  const widths = [...ui.viewports].sort((a, b) => a - b);
  const themes = ui.themes.map(themeOf);
  const visits = [];
  const seen = new Set();
  for (const row of rows.filter((r) => r.path)) {
    if (seen.has(`${row.path}|${row.state}`)) continue;
    seen.add(`${row.path}|${row.state}`);
    for (const theme of themes) {
      for (const width of widths) {
        visits.push({
          key: `${row.path}|${row.state}|${width}|${theme.name}`,
          screen: row.screen, state: row.state, path: row.path, width, theme,
          tabWalk: width === widths[widths.length - 1] && theme === themes[0],
        });
      }
    }
  }
  return { visits: visits.slice(0, ui.maxVisits), dropped: Math.max(0, visits.length - ui.maxVisits) };
}

// ---------- findings ----------

const where = (v) => `\`${v.path}\` (${v.state}) ${v.width}px ${v.theme.name}`;

// Which reviewer owns a finding: ux for whether the page works and can be operated,
// ui for how it looks. axe rules split by their category tag.
export const LANES = ['ui', 'ux'];
const UX_KINDS = new Set(['app-start', 'load-failed', 'http-status', 'page-error', 'console-error', 'request-failed', 'focus-trap']);
const UX_AXE = new Set(['cat.keyboard', 'cat.name-role-value', 'cat.forms', 'cat.aria']);
export const laneOf = (f) => ((f.kind === 'axe' ? (f.cats || []).some((c) => UX_AXE.has(c)) : UX_KINDS.has(f.kind)) ? 'ux' : 'ui');

/** What identifies a finding across the head and base runs of the same visit. */
export const fingerprint = (f) => [f.kind, f.rule || '', f.target || '', f.kind === 'page-error' ? f.message : ''].join('|');

/**
 * Marks each blocking finding new, pre-existing (the base has it at the same visit) or
 * unverified (no base to compare with). Only new ones block.
 */
export function compareWithBase(head, base) {
  for (const v of head) {
    const was = base ? base.find((b) => b.key === v.key) : null;
    const known = new Set((was?.findings || []).map(fingerprint));
    for (const f of v.findings) {
      if (f.level !== 'fail') continue;
      if (!base) f.origin = 'unverified';
      else f.origin = known.has(fingerprint(f)) ? 'pre-existing' : 'new';
    }
  }
}

/**
 * The visit that stands for an app that didn't start. If the merge base starts, the
 * change broke it, which blocks. If the base doesn't start either, or couldn't be
 * prepared, it's unverified: it doesn't block, but the ux reviewer must answer it.
 */
export function startupVisit(error, baseStarted) {
  return {
    key: 'serve', screen: 'the app', state: 'start', path: '/', width: 0, theme: themeOf('—'),
    status: null, cls: null, screenshot: null, tab: null,
    findings: [baseStarted
      ? { kind: 'app-start', level: 'fail', origin: 'new', message: `the app starts on the merge base but not on this commit: ${error}` }
      : { kind: 'app-start', level: 'fail', origin: 'unverified', message: `the app didn't start: ${error}` }],
  };
}

/** Distinct findings (one per screen, state and finding, across viewports and themes), as [visit, finding]. */
export function distinct(visits, pick = () => true) {
  const seen = new Map();
  for (const v of visits) {
    for (const f of v.findings.filter(pick)) {
      const k = `${v.path}|${v.state}|${fingerprint(f)}`;
      if (!seen.has(k)) seen.set(k, [v, f]);
    }
  }
  return [...seen.values()];
}

export function tally(visits) {
  const count = (pick) => distinct(visits, pick).length;
  return {
    failures: count((f) => f.level === 'fail' && f.origin === 'new'),
    preExisting: count((f) => f.origin === 'pre-existing'),
    unverified: count((f) => f.origin === 'unverified'),
    warnings: count((f) => f.level === 'warn'),
  };
}

/** Turns what one visit measured into findings, each `fail` (can block) or `warn`. */
export function findingsOf(m, state) {
  const out = [];
  const expectsError = /error|not-found/.test(state);
  if (m.loadError) out.push({ kind: 'load-failed', level: 'fail', message: m.loadError });
  if (m.status >= 400) {
    out.push({ kind: 'http-status', level: expectsError ? 'warn' : 'fail', message: `the page returned ${m.status}` });
  }
  for (const message of m.pageErrors || []) out.push({ kind: 'page-error', level: 'fail', message });
  if (m.overflow) {
    out.push({
      kind: 'overflow', level: 'fail', target: m.overflow.offenders.join(', '),
      message: `page is ${m.overflow.scrollWidth}px wide in a ${m.overflow.width}px viewport`,
    });
  }
  for (const v of m.axe || []) {
    for (const node of v.nodes) {
      out.push({
        kind: 'axe', rule: v.id, impact: v.impact, cats: v.cats, target: node.target,
        level: v.impact === 'serious' || v.impact === 'critical' ? 'fail' : 'warn',
        message: v.help, detail: node.summary, help: v.helpUrl,
      });
    }
  }
  for (const message of m.consoleErrors || []) out.push({ kind: 'console-error', level: 'warn', message });
  for (const message of m.failedRequests || []) out.push({ kind: 'request-failed', level: 'warn', message });
  if (m.cls != null && m.cls > CLS_LIMIT) {
    out.push({ kind: 'layout-shift', level: 'warn', message: `CLS ${m.cls.toFixed(3)} (limit ${CLS_LIMIT})` });
  }
  for (const stop of m.tab?.stops || []) {
    if (stop.visible === false) {
      out.push({ kind: 'focus-not-visible', level: 'warn', target: stop.selector, message: `no visible change when ${stop.role} "${stop.name}" has focus` });
    }
  }
  if (m.tab?.trap) out.push({ kind: 'focus-trap', level: 'warn', target: m.tab.trap, message: 'Tab stays on this element' });
  return out;
}

/**
 * Masks what a probe record mustn't keep, since probe.json and probe.md are committed
 * with the job: URL credentials, query strings and fragments (signed URLs, tokens),
 * secret-looking query parameters elsewhere, bearer tokens, JWTs, emails, and long
 * opaque path segments (session IDs, keys). Head and base runs mask alike, so their
 * findings still match.
 */
export function redact(text) {
  return String(text)
    .replace(/\b([a-z][\w+.-]*:\/\/)[^\s/@'"<>]+@/gi, '$1…@')
    .replace(/\b(https?:\/\/[^\s?#'"<>]*)[?#][^\s'"<>]*/gi, '$1?…')
    .replace(/([?&][^=&\s#'"<>]*(?:token|key|secret|sig|password|passwd|auth|session|code)[^=&\s#'"<>]*=)[^&\s#'"<>]+/gi, '$1…')
    .replace(/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer …')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '…')
    .replace(/[\w.+-]+@[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}/gi, '…@…')
    .replace(/\/(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{24,}(?=[/?#\s'"<>]|$)/gi, '/…');
}

// ---------- report ----------

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Findings grouped by what they are, listing every viewport and theme they appear at. */
function grouped(visits, pick) {
  const groups = new Map();
  for (const v of visits) {
    for (const f of v.findings.filter(pick)) {
      const k = `${v.path}|${v.state}|${fingerprint(f)}`;
      const g = groups.get(k) || { f, v, at: [] };
      g.at.push(v.key === 'serve' ? 'startup' : `${v.width}px ${v.theme.name}`);
      groups.set(k, g);
    }
  }
  return [...groups.values()];
}

const SECTIONS = [
  { prefix: 'F', heading: 'Failures (block the round)', pick: (f) => f.level === 'fail' && f.origin === 'new',
    note: 'Introduced by this change: the merge base doesn\'t have them.' },
  { prefix: 'U', heading: 'Unverified', pick: (f) => f.origin === 'unverified',
    note: 'Would block, but the probe couldn\'t compare with the merge base, so they don\'t. Check each one.' },
  { prefix: 'P', heading: 'Pre-existing', pick: (f) => f.origin === 'pre-existing',
    note: 'The merge base has these too, so they don\'t block.' },
  { prefix: 'W', heading: 'Warnings', pick: (f) => f.level === 'warn', note: 'Measured, not blocking: reviewers judge them.' },
];

/**
 * probe.md's items, numbered per section: F (blocking), U (unverified), P
 * (pre-existing), W (warnings), N (screens not visited). Each has a lane.
 */
export function numbered(r) {
  const items = [];
  for (const s of SECTIONS) {
    grouped(r.visits, s.pick).forEach((g, i) => items.push({ id: `${s.prefix}${i + 1}`, section: s.prefix, lane: laneOf(g.f), ...g }));
  }
  (r.unreached || []).forEach((u, i) => items.push({ id: `N${i + 1}`, section: 'N', lane: 'ux', u }));
  return items;
}

function findingTable(items) {
  const out = ['| ID | Lane | Screen | Where | What | Detail |', '|---|---|---|---|---|---|'];
  for (const { id, lane, f, v, at } of items) {
    const what = f.kind === 'axe' ? `axe \`${f.rule}\` (${f.impact})` : f.kind;
    const detail = [f.message, f.target && `\`${f.target}\``, f.detail].filter(Boolean).join(' — ');
    out.push(`| ${id} | ${lane} | \`${v.path}\` (${v.state}) | ${at.join(', ')} | ${what} | ${cell(detail)} |`);
  }
  return out;
}

export function renderProbe(r) {
  const title = r.round ? `round ${r.round}` : 'local run';
  const out = [`# UI probe — ${r.id}, ${title}`, ''];
  if (r.status !== 'ran') {
    out.push(`**${r.status === 'skipped' ? 'Skipped' : 'Not run'}:** ${r.reason}`, '');
    return out.join('\n');
  }
  out.push(`Commit \`${r.sha}\`, served by \`${r.serve}\` from the worktree. Chromium ${r.browser}; axe-core ${r.axe} with WCAG 2.2 A/AA rules.`, '');
  const t = tally(r.visits);
  out.push(`**Result:** ${t.failures ? `${t.failures} new failure(s) — the round is blocked until they're fixed` : 'no new failures'}; ${t.warnings} warning(s)${t.preExisting ? `; ${t.preExisting} pre-existing` : ''}${t.unverified ? `; ${t.unverified} unverified` : ''}.`, '');
  if (r.baseNote) out.push(r.baseNote, '');
  out.push('IDs are for reviews to cite. Lane says which reviewer answers for the item: `ui` (how it looks) or `ux` (whether it works).', '');

  const items = numbered(r);
  for (const s of SECTIONS) {
    const mine = items.filter((x) => x.section === s.prefix);
    if (mine.length) out.push(`## ${s.heading}`, '', s.note, '', ...findingTable(mine), '');
  }

  const unreached = items.filter((x) => x.section === 'N');
  if (unreached.length || r.dropped) {
    out.push('## Not visited', '', 'States the probe couldn\'t open. Each needs a test that renders it.', '');
    for (const { id, lane, u } of unreached) out.push(`- ${id} (${lane}): ${u.screen} (${u.state}): ${u.reason}`);
    if (r.dropped) out.push(`- ${r.dropped} more visit(s) over \`ui.maxVisits\``);
    out.push('');
  }

  out.push('## Screens', '', '| Screen | State | Viewport | Theme | Status | CLS | Screenshot |', '|---|---|---|---|---|---|---|');
  for (const v of r.visits.filter((x) => x.key !== 'serve')) {
    const cls = v.cls == null ? '—' : v.cls.toFixed(3);
    out.push(`| \`${v.path}\` | ${v.state} | ${v.width}px | ${v.theme.name} | ${v.status ?? 'failed'} | ${cls} | ${v.screenshot ? `\`${v.screenshot}\`` : '—'} |`);
  }
  out.push('');

  for (const v of r.visits.filter((x) => x.tab)) {
    out.push(`## Tab order — ${where(v)}`, '');
    if (!v.tab.stops.length) out.push('No element takes focus.');
    v.tab.stops.forEach((s, i) => {
      const flag = s.visible === false ? ' — **focus not visible**' : s.visible == null ? ' — focus style not compared' : '';
      out.push(`${i + 1}. ${s.role} "${cell(s.name)}" \`${s.selector}\`${flag}`);
    });
    const end = v.tab.trap ? `Focus is stuck on \`${v.tab.trap}\`.` : v.tab.complete ? 'Tab leaves the page after the last stop.' : `Stopped after ${v.tab.stops.length} stops (\`ui.tabStops\`).`;
    out.push('', end, '');
  }
  return out.join('\n');
}

// ---------- checking a review ----------

function section(markdown, heading) {
  const m = new RegExp(`^## ${heading}[^\n]*\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(markdown);
  return m ? m[1] : '';
}

/**
 * The probe IDs some text names, with ranges expanded: `W1–W4` (or `W1-W4`, `W1-4`)
 * names W1, W2, W3 and W4.
 */
export function probeIds(text) {
  const ids = new Set();
  const re = /(?<![A-Za-z0-9])([FUPWN])(\d+)(?:(?:\s*[-–]\s*\1|[-–])(\d+))?(?![A-Za-z0-9])/g;
  for (const [, prefix, from, to] of text.matchAll(re)) {
    const last = to === undefined ? Number(from) : Number(to);
    for (let k = Number(from); k <= Math.max(Number(from), last); k++) ids.add(`${prefix}${k}`);
  }
  return ids;
}

/**
 * What a probe reviewer's review leaves out. It answers every U, W and N item in the
 * lanes it owns under `## Probe findings`, and lists the screenshots it viewed under
 * `## Coverage`: all of them for the ui lane, the Tab-order visits for ux. A lane
 * whose reviewer isn't running this round falls to the probe reviewers that are.
 */
export function reviewGaps({ probe, review, name, running }) {
  if (probe?.status !== 'ran') return [];
  const lanes = LANES.filter((l) => l === name || !running.includes(l));
  if (!lanes.length) return [];
  const answered = probeIds(section(review, 'Probe findings'));
  const ids = numbered(probe)
    .filter((x) => ['U', 'W', 'N'].includes(x.section) && lanes.includes(x.lane))
    .map((x) => x.id)
    .filter((id) => !answered.has(id));
  const viewed = section(review, 'Coverage');
  const shots = probe.visits
    .filter((v) => v.screenshot && (lanes.includes('ui') || (lanes.includes('ux') && v.tab)))
    .map((v) => v.screenshot)
    .filter((shot) => !viewed.includes(shot.split('/').pop()));
  return [...ids, ...shots];
}

/** reviewGaps for reviewer `name` in round n of a job, from the files. */
export function checkReview(root, id, n, name) {
  const config = readJson(join(root, 'factory/config.json')) || {};
  if (!config.reviewers?.[name]?.probe) return { ok: true, missing: [] };
  const roundDir = join(root, 'factory/jobs', id, `round-${n}`);
  const round = readJson(join(roundDir, 'round.json'));
  const probe = round?.probe?.status === 'ran' ? readJson(join(roundDir, 'probe.json')) : null;
  let review = '';
  try { review = readFileSync(join(roundDir, `review-${name}.md`), 'utf8'); } catch { /* none yet */ }
  const running = Object.entries(round?.reviewers || {}).filter(([k, r]) => r.run && config.reviewers?.[k]?.probe).map(([k]) => k);
  const missing = reviewGaps({ probe, review, name, running });
  return { ok: !missing.length, missing };
}

// ---------- in the page ----------

// Selector and accessible-name helpers, evaluated once per page.
const HELPERS = `(() => {
  const text = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  window.__factorySel = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let s = e.localName + [...e.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      const p = e.parentElement;
      const same = p ? [...p.children].filter((c) => c.localName === e.localName) : [];
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
      parts.unshift(s);
      if (e.localName === 'body') break;
    }
    return parts.join(' > ');
  };
  window.__factoryName = (el) => {
    const by = el.getAttribute('aria-labelledby');
    const labelled = by && text(by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '));
    const name = labelled || text(el.getAttribute('aria-label'))
      || (el.labels && el.labels.length ? text([...el.labels].map((l) => l.textContent).join(' ')) : '')
      || text(el.getAttribute('alt')) || text(el.textContent) || text(el.getAttribute('title'))
      || text(el.getAttribute('placeholder'));
    return name.slice(0, 60);
  };
  window.__factoryRole = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const t = el.localName;
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') return ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button' })[el.type] || 'textbox';
    return t;
  };
  const FOCUS_PROPS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset', 'boxShadow', 'borderTopColor',
    'borderBottomColor', 'backgroundColor', 'color', 'textDecorationLine'];
  window.__factoryFocusStyle = (el) => { const cs = getComputedStyle(el); return FOCUS_PROPS.map((p) => cs[p]).join('|'); };
  window.__factoryRest = new WeakMap();
  window.__factoryIds = new WeakMap();
  window.__factoryNext = 0;
})()`;

const CLS_SCRIPT = `window.__factoryCls = 0;
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__factoryCls += e.value;
  }).observe({ type: 'layout-shift', buffered: true });
} catch {}`;

function measureOverflow() {
  const width = document.documentElement.clientWidth;
  const scrollWidth = document.documentElement.scrollWidth;
  if (scrollWidth <= width + 1) return null;
  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= width + 1) continue;
    const p = el.parentElement;
    if (p && p !== document.body && p.getBoundingClientRect().right > width + 1) continue;
    offenders.push(window.__factorySel(el));
    if (offenders.length >= 5) break;
  }
  return { width, scrollWidth, offenders };
}

// Records how every focusable element looks at rest, before any of them has focus.
function recordRest() {
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';
  for (const el of document.querySelectorAll(sel)) window.__factoryRest.set(el, window.__factoryFocusStyle(el));
  document.activeElement?.blur?.();
}

function readFocus() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  if (!window.__factoryIds.has(el)) window.__factoryIds.set(el, ++window.__factoryNext);
  const rest = window.__factoryRest.get(el);
  return {
    id: window.__factoryIds.get(el),
    selector: window.__factorySel(el),
    role: window.__factoryRole(el),
    name: window.__factoryName(el),
    frame: el.localName === 'iframe',
    visible: rest == null ? null : rest !== window.__factoryFocusStyle(el),
  };
}

async function runAxe([tags, nodes]) {
  const result = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
  return result.violations.map((v) => ({
    id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, cats: v.tags.filter((t) => t.startsWith('cat.')),
    nodes: v.nodes.slice(0, nodes).map((n) => ({ target: n.target.join(' '), summary: (n.failureSummary || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^Fix (any|all) of the following:$/.test(l)).slice(0, 2).join(' ') })),
  }));
}

// ---------- browsing ----------

const slug = (s) => s.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root';

/**
 * What one Tab press means, given the stops so far and where focus went (null when it
 * left the page, as Chromium does after the last stop). Staying put is a trap, or on an
 * iframe focus moving inside it, which the walk can't follow. Leaving the page or
 * coming round to the first stop ends the walk. Staying put is checked first, so a
 * trap on the first stop isn't taken for the end.
 */
export function tabStep(stops, s) {
  if (s && stops.length && s.id === stops.at(-1).id) return s.frame ? 'frame' : 'trap';
  if (!s || (stops.length && s.id === stops[0].id)) return 'complete';
  return 'next';
}

async function tabWalk(page, max) {
  await page.evaluate(recordRest);
  const stops = [];
  let trap = null;
  let complete = false;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(readFocus);
    const step = tabStep(stops, s);
    if (step === 'trap') trap = s.selector;
    if (step === 'complete') complete = true;
    if (step !== 'next') break;
    stops.push({ ...s, name: redact(s.name) });
  }
  return { stops, trap, complete };
}

async function visit(browser, origin, v, ctx) {
  const context = await browser.newContext({
    viewport: { width: v.width, height: VIEWPORT_HEIGHT },
    colorScheme: v.theme.colorScheme,
    reducedMotion: 'reduce',
    ...(ctx.storageState ? { storageState: ctx.storageState } : {}),
  });
  await context.addInitScript(CLS_SCRIPT);
  if (v.theme.init) await context.addInitScript(v.theme.init);
  const page = await context.newPage();
  const m = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  const short = (s) => redact(String(s).split('\n')[0]).slice(0, 200);
  page.on('pageerror', (e) => m.pageErrors.push(short(e.message)));
  page.on('console', (msg) => { if (msg.type() === 'error') m.consoleErrors.push(short(msg.text())); });
  page.on('requestfailed', (req) => m.failedRequests.push(`${req.method()} ${redact(req.url())} — ${req.failure()?.errorText}`));
  page.on('response', (res) => {
    if (res.status() >= 400 && res.request().resourceType() !== 'document' && !/\/favicon\.ico$/.test(res.url())) {
      m.failedRequests.push(`${res.request().method()} ${redact(res.url())} → ${res.status()}`);
    }
  });
  try {
    const res = await page.goto(new URL(v.path, origin).href, { waitUntil: 'load', timeout: 30000 });
    m.status = res?.status() ?? null;
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    await page.evaluate(HELPERS);
    m.overflow = await page.evaluate(measureOverflow);
    m.cls = await page.evaluate(() => window.__factoryCls ?? null);
    await page.evaluate(ctx.axeSource);
    m.axe = await page.evaluate(runAxe, [AXE_TAGS, AXE_NODES]);
    if (ctx.shots) {
      const file = join(ctx.shots, `${slug(v.path)}-${slug(v.state)}-${v.width}-${slug(v.theme.name)}.png`);
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: v.width, height: Math.min(height, MAX_SHOT_HEIGHT) } });
      m.screenshot = relative(ctx.outDir, file);
    }
    if (v.tabWalk) m.tab = await tabWalk(page, ctx.tabStops);
  } catch (err) {
    m.loadError = short(err.message);
  } finally {
    await context.close();
  }
  return {
    key: v.key, screen: v.screen, state: v.state, path: v.path, width: v.width, theme: v.theme,
    status: m.status ?? null, cls: m.cls ?? null, screenshot: m.screenshot ?? null, tab: m.tab ?? null,
    findings: findingsOf(m, v.state),
  };
}

// ---------- serving ----------

function freePort() {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', fail);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => done(port)); });
  });
}

const live = new Set();
const stopServer = (child) => {
  live.delete(child);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
};

/** Starts `ui.serve` in cwd on a free port, waits for the URL to answer, and runs fn(origin). */
async function withServer(cwd, ui, fn) {
  const port = await freePort();
  const fill = (s) => s.replaceAll('{port}', String(port));
  const child = spawn(fill(ui.serve), {
    cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), BROWSER: 'none', CI: process.env.CI || 'true' },
  });
  live.add(child);
  let output = '';
  const keep = (d) => { output = (output + d).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code) => { exited = code ?? 1; });
  const origin = fill(ui.url);
  const tail = (n) => {
    const all = output.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const errors = all.filter((l) => /error/i.test(l));
    return redact((errors.length ? errors.slice(0, 3) : all.slice(-n)).join(' / '));
  };
  try {
    const deadline = Date.now() + ui.readyTimeout * 1000;
    for (;;) {
      if (exited != null) throw new Error(`\`${fill(ui.serve)}\` exited ${exited}: ${tail(5)}`);
      if (Date.now() > deadline) throw new Error(`${origin} didn't answer within ${ui.readyTimeout}s: ${tail(3)}`);
      try {
        await fetch(origin, { signal: AbortSignal.timeout(2000) });
        break;
      } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    return { ok: true, value: await fn(origin) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    stopServer(child);
  }
}

// ---------- the merge base ----------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
}

/**
 * A detached checkout of the merge base beside the job's worktree, prepared the same
 * way (config.worktree: links and setup). With no setup command it borrows the
 * worktree's node_modules instead, which is refused when the change touches
 * dependency files, since the base couldn't run on the branch's packages.
 */
/**
 * The dependency files the work in a worktree changes since mergeBase. Uncommitted and
 * untracked ones count, since the builder runs the probe before committing.
 */
export function depChanges(worktree, mergeBase) {
  const nul = (text) => text.split('\0').filter(Boolean);
  return [
    ...nul(git(['diff', '-z', '--name-only', mergeBase], worktree)),
    ...nul(git(['ls-files', '-z', '--others', '--exclude-standard'], worktree)),
  ].filter((f) => DEP_FILES.test(f));
}

function baseCheckout(root, id, worktree, mergeBase, settings) {
  if (!settings.setup) {
    const deps = depChanges(worktree, mergeBase);
    if (deps.length) return { error: `the change touches ${deps.join(', ')} and \`worktree.setup\` isn't set to install the base's packages` };
  }
  const dir = join(root, '.factory-worktrees', `${id}.probe-base`);
  const modules = join(dir, 'node_modules');
  let links = [];
  const cleanup = () => {
    unlinkFiles(dir, links);
    try { if (lstatSync(modules).isSymbolicLink()) unlinkSync(modules); } catch { /* none */ }
    try { git(['worktree', 'remove', '--force', dir], root); } catch { rmSync(dir, { recursive: true, force: true }); }
  };
  if (existsSync(dir)) cleanup();
  try {
    git(['worktree', 'add', '--detach', dir, mergeBase], root);
  } catch (err) {
    return { error: `couldn't check out the merge base: ${String(err.stderr || err.message).trim()}` };
  }
  if (!settings.setup && existsSync(join(worktree, 'node_modules')) && !existsSync(modules)) {
    symlinkSync(join(worktree, 'node_modules'), modules, 'dir');
  }
  const prep = prepareWorktree(root, dir, settings);
  links = prep.links;
  if (!prep.ok) {
    cleanup();
    return { error: `couldn't prepare the merge base: ${prep.error}` };
  }
  return { dir, cleanup };
}

// ---------- the probe ----------

function load(name, dirs) {
  for (const d of dirs) {
    try { return createRequire(join(d, 'package.json'))(name); } catch { /* next */ }
  }
  return null;
}

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

export async function runProbe({ root, id, round = null, outDir = null }) {
  const config = readJson(join(root, 'factory/config.json'));
  if (!config) throw new Error('factory/config.json is missing or not valid JSON');
  const ui = { ...DEFAULTS, ...(config.ui || {}) };
  const worktree = join(root, '.factory-worktrees', id);
  const jobDir = join(root, 'factory/jobs', id);
  outDir ||= round ? join(jobDir, `round-${round}`) : mkdtempSync(join(tmpdir(), `factory-probe-${id}-`));
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(worktree)) throw new Error(`worktree ${worktree} doesn't exist`);

  const sha = git(['rev-parse', 'HEAD'], worktree);
  const r = { id, round, sha, serve: ui.serve, status: 'ran', reason: null, visits: [], unreached: [], dropped: 0 };

  const finish = () => {
    if (r.status === 'ran') Object.assign(r, tally(r.visits));
    writeFileSync(join(outDir, 'probe.json'), `${JSON.stringify(r, null, 2)}\n`);
    writeFileSync(join(outDir, 'probe.md'), renderProbe(r));
    const failures = distinct(r.visits, (f) => f.level === 'fail' && f.origin === 'new');
    return {
      status: r.status, reason: r.reason, failures: r.failures || 0, warnings: r.warnings || 0,
      file: join(outDir, 'probe.md'),
      top: failures.slice(0, 5).map(([v, f]) => `${v.key === 'serve' ? '' : `${v.path} (${v.state}) `}${f.kind === 'axe' ? `axe ${f.rule}` : f.kind}: ${f.message}${f.target ? ` (${f.target})` : ''}`),
    };
  };
  const skip = (reason, status = 'skipped') => { Object.assign(r, { status, reason }); return finish(); };

  if (!ui.serve) return skip('`ui.serve` is not set in factory/config.json.');
  const rows = parseScreens(readFileSync(join(jobDir, 'spec.md'), 'utf8'));
  r.unreached = rows.filter((x) => !x.path);
  const plan = planVisits(rows, ui);
  r.dropped = plan.dropped;
  if (!plan.visits.length) return skip(rows.length ? 'no screen in spec.md\'s Screens table has a URL.' : 'spec.md lists no screens.');

  const pw = load('playwright', [worktree, root]) || load('@playwright/test', [worktree, root]);
  if (!pw?.chromium) return skip('Playwright isn\'t installed in the repo (`npm i -D playwright`).');
  const axe = load('axe-core', [worktree, root]);
  if (!axe?.source) return skip('axe-core isn\'t installed in the repo (`npm i -D axe-core`).');
  let browser;
  try {
    browser = await pw.chromium.launch();
  } catch (err) {
    return skip(`Chromium didn't start (\`npx playwright install chromium\`): ${err.message.split('\n')[0]}`);
  }

  const storageState = ui.storageState ? resolve(root, ui.storageState) : null;
  if (storageState && !existsSync(storageState)) {
    await browser.close();
    return skip(`\`ui.storageState\` file ${ui.storageState} doesn't exist.`);
  }
  r.browser = browser.version();
  r.axe = axe.version;
  const shots = join(outDir, 'probe');
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const ctx = { axeSource: axe.source, storageState, tabStops: ui.tabStops, outDir };
  const browse = (visits, withShots) => async (origin) => {
    const out = [];
    for (const v of visits) out.push(await visit(browser, origin, v, { ...ctx, shots: withShots ? shots : null }));
    return out;
  };

  try {
    const head = await withServer(worktree, ui, browse(plan.visits, true));
    const mergeBase = git(['merge-base', config.baseBranch, 'HEAD'], worktree);
    const needsBase = head.ok
      ? plan.visits.filter((v) => head.value.find((h) => h.key === v.key)?.findings.some((f) => f.level === 'fail'))
      : [];
    if (head.ok && !needsBase.length) {
      r.visits = head.value;
      return finish();
    }

    // Something would block: run the same visits on the merge base to see if it's new.
    const base = baseCheckout(root, id, worktree, mergeBase, config.worktree || {});
    let baseRun = null;
    try {
      if (base.error) r.baseNote = `Couldn't compare with the merge base: ${base.error}.`;
      else {
        baseRun = await withServer(base.dir, ui, browse(head.ok ? needsBase : plan.visits.slice(0, 1), false));
        if (!baseRun.ok) r.baseNote = `Couldn't compare with the merge base: the app didn't start there either (${baseRun.error}).`;
      }
    } finally {
      base.cleanup?.();
    }

    if (!head.ok) {
      r.visits = [startupVisit(head.error, baseRun?.ok ?? false)];
      return finish();
    }
    r.visits = head.value;
    compareWithBase(r.visits, baseRun?.ok ? baseRun.value : null);
    return finish();
  } finally {
    await browser.close();
  }
}

function main() {
  if (process.argv[2] === 'check-review') {
    const [id, n, name] = process.argv.slice(3);
    if (!id || !Number.isInteger(Number(n)) || !name) {
      console.error('Usage: node probe.mjs check-review <job-id> <round> <reviewer>');
      process.exit(2);
    }
    const root = git(['rev-parse', '--show-toplevel'], dirname(fileURLToPath(import.meta.url)));
    console.log(JSON.stringify(checkReview(root, id, Number(n), name)));
    return;
  }
  const [id, raw] = process.argv.slice(2);
  const round = raw === undefined ? null : Number(raw);
  if (!id || (round !== null && (!Number.isInteger(round) || round < 1))) {
    console.error('Usage: node probe.mjs <job-id> [round]');
    process.exit(2);
  }
  const stop = (code) => () => { for (const c of [...live]) stopServer(c); process.exit(code); };
  process.on('SIGTERM', stop(143));
  process.on('SIGINT', stop(130));
  const root = git(['rev-parse', '--show-toplevel'], dirname(fileURLToPath(import.meta.url)));
  runProbe({ root, id, round }).then(
    (summary) => console.log(JSON.stringify(summary)),
    (err) => {
      for (const c of [...live]) stopServer(c);
      console.error(`probe.mjs: ${(err.stderr || err.message || String(err)).toString().trim()}`);
      process.exit(1);
    },
  );
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) main();
