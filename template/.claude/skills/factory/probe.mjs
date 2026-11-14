#!/usr/bin/env node
// UI probe: serves the job's worktree, opens every screen and state spec.md lists at
// each viewport and theme, and measures them, so UI and UX reviews start from facts
// rather than a diff.
//
//   node .claude/skills/factory/probe.mjs <job-id> [round]
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
        kind: 'axe', rule: v.id, impact: v.impact, target: node.target,
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

function findingTable(groups) {
  const out = ['| # | Screen | Where | What | Detail |', '|---|---|---|---|---|'];
  groups.forEach(({ f, v, at }, i) => {
    const what = f.kind === 'axe' ? `axe \`${f.rule}\` (${f.impact})` : f.kind;
    const detail = [f.message, f.target && `\`${f.target}\``, f.detail].filter(Boolean).join(' — ');
    out.push(`| ${i + 1} | \`${v.path}\` (${v.state}) | ${at.join(', ')} | ${what} | ${cell(detail)} |`);
  });
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

  const sections = [
    ['Failures (block the round)', (f) => f.level === 'fail' && f.origin === 'new',
      'Introduced by this change: the merge base doesn\'t have them.'],
    ['Unverified', (f) => f.origin === 'unverified',
      'Would block, but the probe couldn\'t compare with the merge base, so they don\'t. Check each one.'],
    ['Pre-existing', (f) => f.origin === 'pre-existing',
      'The merge base has these too, so they don\'t block.'],
    ['Warnings', (f) => f.level === 'warn', 'Measured, not blocking: reviewers judge them.'],
  ];
  for (const [heading, pick, note] of sections) {
    const groups = grouped(r.visits, pick);
    if (!groups.length) continue;
    out.push(`## ${heading}`, '', note, '', ...findingTable(groups), '');
  }

  if (r.unreached.length || r.dropped) {
    out.push('## Not visited', '');
    for (const u of r.unreached) out.push(`- ${u.screen} (${u.state}): ${u.reason}`);
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
    id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
    nodes: v.nodes.slice(0, nodes).map((n) => ({ target: n.target.join(' '), summary: (n.failureSummary || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^Fix (any|all) of the following:$/.test(l)).slice(0, 2).join(' ') })),
  }));
}

// ---------- browsing ----------

const slug = (s) => s.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root';

async function tabWalk(page, max) {
  await page.evaluate(recordRest);
  const stops = [];
  let trap = null;
  let complete = false;
  let last = null;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(readFocus);
    if (!s || (stops.length && s.id === stops[0].id)) { complete = true; break; }
    if (last && s.id === last.id) {
      if (!s.frame) trap = s.selector;
      break;
    }
    stops.push(s);
    last = s;
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
  const short = (s) => String(s).split('\n')[0].slice(0, 200);
  page.on('pageerror', (e) => m.pageErrors.push(short(e.message)));
  page.on('console', (msg) => { if (msg.type() === 'error') m.consoleErrors.push(short(msg.text())); });
  page.on('requestfailed', (req) => m.failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`));
  page.on('response', (res) => {
    if (res.status() >= 400 && res.request().resourceType() !== 'document' && !/\/favicon\.ico$/.test(res.url())) {
      m.failedRequests.push(`${res.request().method()} ${res.url()} → ${res.status()}`);
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
    return (errors.length ? errors.slice(0, 3) : all.slice(-n)).join(' / ');
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
 * A detached checkout of the merge base beside the job's worktree, sharing its
 * node_modules. Refused when the change touches dependency files, since the base
 * couldn't run on the branch's packages.
 */
function baseCheckout(root, id, worktree, mergeBase) {
  const deps = git(['diff', '--name-only', mergeBase, 'HEAD'], worktree).split('\n').filter((f) => DEP_FILES.test(f));
  if (deps.length) return { error: `the change touches ${deps.join(', ')}` };
  const dir = join(root, '.factory-worktrees', `${id}.probe-base`);
  const modules = join(dir, 'node_modules');
  const cleanup = () => {
    try { if (lstatSync(modules).isSymbolicLink()) unlinkSync(modules); } catch { /* none */ }
    try { git(['worktree', 'remove', '--force', dir], root); } catch { rmSync(dir, { recursive: true, force: true }); }
  };
  if (existsSync(dir)) cleanup();
  try {
    git(['worktree', 'add', '--detach', dir, mergeBase], root);
  } catch (err) {
    return { error: `couldn't check out the merge base: ${String(err.stderr || err.message).trim()}` };
  }
  if (existsSync(join(worktree, 'node_modules')) && !existsSync(modules)) symlinkSync(join(worktree, 'node_modules'), modules, 'dir');
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
    const base = baseCheckout(root, id, worktree, mergeBase);
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
      if (!baseRun?.ok) return skip(`the app didn't start: ${head.error}`, 'error');
      // The base serves and this commit doesn't: the change broke it.
      r.visits = [{
        key: 'serve', screen: 'the app', state: 'start', path: '/', width: 0, theme: themeOf('—'),
        status: null, cls: null, screenshot: null, tab: null,
        findings: [{ kind: 'app-start', level: 'fail', origin: 'new', message: `the app starts on the merge base but not on this commit: ${head.error}` }],
      }];
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
