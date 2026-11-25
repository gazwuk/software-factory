#!/usr/bin/env node
// Retro facts: what a finished job's files say about the path it took. No model.
// The retro agent (factory-retro) explains these facts in retro.md; this file only
// counts, so the numbers in a retro can be trusted.
//
//   node retro.mjs prepare <job-id> [--stage merged]
//                                      write factory/jobs/<id>/retro.json, print one line of JSON
//   node retro.mjs summary [--last N]  tally the most recent retros across jobs, as markdown
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJob, now, readBoard, readJson, writeJsonAtomic } from './board.mjs';

/** Cause tags a retro may use, so causes can be counted across jobs. */
export const TAGS = [
  'request-gap', 'spec-gap', 'build-miss', 'missing-check', 'profile-gap',
  'reviewer-noise', 'reviewer-miss', 'flaky-check', 'environment', 'policy',
];

const ACTIVE = new Set(['spec', 'build', 'review', 'approval']);
const SHIPPED = new Set(['merged', 'pr-open']);

const readText = (path) => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

const firstLine = (text) => (text ?? '').split('\n', 1)[0].trim();

/** The body of a `## <heading>` section, or '' when there isn't one. */
export function section(markdown, heading) {
  const m = new RegExp(`^## ${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(markdown ?? '');
  return m ? m[1].trim() : '';
}

const hasSection = (markdown, heading) => new RegExp(`^## ${heading}\\b`, 'm').test(markdown ?? '');

/** A review's blocking findings: the numbered items under `## Blocking` (the whole review if it has no such heading). */
export function blockingCount(review) {
  if (/^VERDICT:\s*CHANGES\b/.test(firstLine(review)) === false) return 0;
  const body = hasSection(review, 'Blocking') ? section(review, 'Blocking') : review;
  return (body.match(/^\d+\.\s/gm) || []).length;
}

const FIXED = /^(fixed|done|addressed|resolved|changed)\b/i;
const DISPUTED = /^(not (changed|fixed|done|a defect)|skipped|won'?t|declined|disagree|no change|left as is|kept)/i;

/**
 * The builder's answers in build.md, by round: `## Round N response` sections whose
 * bullets read `- **<reviewer> #<n> <title>** — fixed in … | not changed: …`.
 */
export function roundResponses(build) {
  const out = {};
  const re = /^## Round (\d+) response\b[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm;
  for (const m of (build ?? '').matchAll(re)) {
    const items = (out[Number(m[1])] ||= []);
    for (const line of m[2].split('\n')) {
      const b = /^\s*[-*]\s+\*\*(.+?)\*\*\s*[—–:-]+\s*(.*)$/.exec(line);
      if (!b) continue;
      const who = /^([A-Za-z0-9-]+)(?:\s+#(\d+))?\s*(.*)$/.exec(b[1].trim());
      if (!who) continue;
      const rest = b[2].trim();
      items.push({
        reviewer: who[1].toLowerCase(),
        finding: who[2] ? Number(who[2]) : null,
        title: who[3].trim(),
        outcome: FIXED.test(rest) ? 'fixed' : DISPUTED.test(rest) ? 'disputed' : 'other',
        note: rest.length > 200 ? `${rest.slice(0, 199)}…` : rest,
      });
    }
  }
  return out;
}

const bullets = (text) => text.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l) && !/^\s*[-*]\s+none\b/i.test(l)).length;

function usageRecords(dir) {
  const usage = join(dir, 'usage');
  if (!existsSync(usage)) return [];
  return readdirSync(usage).filter((n) => n.endsWith('.json')).map((n) => readJson(join(usage, n))).filter(Boolean);
}

const roleOf = (agent) => (agent.startsWith('review-') ? 'reviewers' : agent);
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Everything retro.json holds for a job, from its board entry and files. `stage`
 * stands in for the board's: Ship prepares the facts just before the record commit,
 * when the job is about to be merged but isn't yet.
 */
export function retroFacts(root, id, { stage } = {}) {
  const found = getJob(root, id);
  if (!found) throw new Error(`no job ${id} on the board`);
  const job = stage ? { ...found, stage } : found;
  const dir = join(root, 'factory/jobs', id);
  const spec = readText(join(dir, 'spec.md')) ?? '';
  const responses = roundResponses(readText(join(dir, 'build.md')));
  const usage = usageRecords(dir);
  const n = job.round || 0;
  const names = job.reviewers || [];
  const why = [];

  const reviewers = Object.fromEntries(names.map((name) => [name,
    { reviews: 0, changes: 0, blocking: 0, fixed: 0, disputed: 0, conceded: 0, held: 0 }]));
  const escalations = [];
  const escalation = (path, round) => {
    const text = readText(path);
    if (firstLine(text) !== 'ESCALATE') return false;
    escalations.push({ round, reason: /^Reason:\s*(.+)$/m.exec(text)?.[1].trim() || null });
    return true;
  };

  let reworks = 0;
  const perRound = [];
  for (let r = 0; r <= n; r++) {
    const rd = join(dir, `round-${r}`);
    const human = existsSync(join(rd, 'human.md'));
    if (human) reworks++;
    const escalated = escalation(join(rd, 'decision.md'), r);
    if (r === 0) {
      if (human) why.push('a human sent the job back before round 1');
      continue;
    }
    const rj = readJson(join(rd, 'round.json'));
    const answered = r in responses;
    const builderRuns = usage.filter((u) => u.agent === 'builder' && u.round === r).length;
    const checkFixes = job.runner?.checkFixes?.[r] ?? Math.max(0, builderRuns - (answered ? 1 : 0));
    const verdicts = {};
    for (const name of names) {
      const text = readText(join(rd, `review-${name}.md`));
      const verdict = /^VERDICT:\s*(PASS|CHANGES)\b/.exec(firstLine(text))?.[1] || null;
      const ran = rj?.reviewers?.[name] ? Boolean(rj.reviewers[name].run) : text !== null;
      if (!ran) { verdicts[name] = { verdict: 'SKIPPED' }; continue; }
      if (!verdict) { verdicts[name] = { verdict: 'missing' }; continue; }
      const mine = (responses[r] || []).filter((i) => i.reviewer === name);
      const v = {
        verdict,
        model: rj?.reviewers?.[name]?.model ?? null,
        blocking: blockingCount(text),
        fixed: mine.filter((i) => i.outcome === 'fixed').length,
        disputed: mine.filter((i) => i.outcome === 'disputed').length,
      };
      verdicts[name] = v;
      const t = reviewers[name];
      t.reviews++;
      if (verdict === 'CHANGES') {
        t.changes++;
        why.push(`${name} asked for changes in round ${r} (${v.blocking} blocking)`);
      }
      t.blocking += v.blocking;
      t.fixed += v.fixed;
      t.disputed += v.disputed;
    }
    if (checkFixes) why.push(`${checkFixes} check fix${checkFixes > 1 ? 'es' : ''} in round ${r} (round-${r}/round.md has the last run)`);
    if (human) why.push(`a human sent the job back after round ${r} (round-${r}/human.md)`);
    perRound.push({ round: r, checkFixes, human, escalated, probe: rj?.probe?.status ?? null, reviewers: verdicts });
  }
  if (n > 1) why.unshift(`${n} review rounds`);

  // A disputed finding is conceded when that reviewer passes the next round.
  const disputes = [];
  for (const [r, items] of Object.entries(responses)) {
    for (const item of items) {
      if (item.outcome !== 'disputed' || item.reviewer === 'human' || !reviewers[item.reviewer]) continue;
      const next = perRound.find((x) => x.round === Number(r) + 1)?.reviewers[item.reviewer]?.verdict;
      const outcome = next === 'PASS' ? 'conceded' : next === 'CHANGES' ? 'held' : 'open';
      if (outcome !== 'open') reviewers[item.reviewer][outcome]++;
      disputes.push({ round: Number(r), reviewer: item.reviewer, finding: item.finding, title: item.title, reason: item.note, outcome });
    }
  }

  if (escalation(join(dir, 'decision.md'), null)) why.push(`the approver escalated: ${escalations.at(-1).reason || 'no reason given'}`);
  else if (escalations.length) why.push(`escalated ${escalations.length === 1 ? 'once' : `${escalations.length} times`} before the last decision`);
  const shippedBy = SHIPPED.has(job.stage) ? (job.decision === 'APPROVE' ? 'approver' : 'human') : null;
  if (shippedBy === 'human') why.push(`shipped by a human${job.note ? ` (${job.note})` : ''}`);
  if (!SHIPPED.has(job.stage)) why.push(`ended at ${job.stage}${job.note ? `: ${job.note}` : ''}`);

  const byRole = {};
  let usd = 0;
  let activeSeconds = 0;
  for (const u of usage) {
    if (u.agent === 'retro') continue; // the retro doesn't count towards what it explains
    byRole[roleOf(u.agent)] = round4((byRole[roleOf(u.agent)] || 0) + (u.costUsd || 0));
    usd += u.costUsd || 0;
    activeSeconds += u.activeSeconds || 0;
  }

  return {
    version: 1,
    job: id,
    title: job.title || id,
    stage: job.stage,
    round: n,
    roundLimit: job.roundLimit ?? null,
    reworks,
    assumptions: bullets(section(spec, 'Assumptions')),
    shippedBy,
    clean: why.length === 0,
    why,
    perRound,
    reviewers,
    disputes,
    escalations,
    cost: { usd: round4(usd), byRole, activeSeconds },
    preparedAt: now(),
  };
}

export const retroPaths = (root, id) => ({
  json: join(root, 'factory/jobs', id, 'retro.json'),
  md: join(root, 'factory/jobs', id, 'retro.md'),
});

/**
 * Writes retro.json for a job and returns its facts. A retro.json that already says
 * the same (apart from when) is left alone, so preparing twice changes nothing to commit.
 * A retro.md written when the job was at another stage or round no longer explains it,
 * so it's removed (a needs-human job's retro, once the job ships).
 */
export function prepare(root, id, options) {
  const facts = retroFacts(root, id, options);
  const p = retroPaths(root, id);
  const before = readJson(p.json);
  if (before && JSON.stringify({ ...before, preparedAt: null }) === JSON.stringify({ ...facts, preparedAt: null })) return before;
  if (!before || before.stage !== facts.stage || before.round !== facts.round) rmSync(p.md, { force: true });
  writeJsonAtomic(p.json, facts);
  return facts;
}

/** retro.md has been written (it has a Causes section). */
export const retroWritten = (root, id) => hasSection(readText(retroPaths(root, id).md), 'Causes');

/**
 * Whether a job's retro is done for where the job is now: retro.json matches its
 * stage and round, and retro.md is written unless the job was clean.
 */
export function retroDone(root, job) {
  const facts = readJson(retroPaths(root, job.id).json);
  if (!facts || facts.stage !== job.stage || facts.round !== (job.round || 0)) return false;
  return facts.clean || retroWritten(root, job.id);
}

// ---------- across jobs ----------

/** The `- \`tag\` — …` lines under a retro.md's Causes. */
export function causesOf(markdown) {
  return section(markdown, 'Causes').split('\n')
    .map((l) => /^\s*[-*]\s+`?([a-z-]+)`?\s*[—–:-]+\s*(.*)$/.exec(l))
    .filter((m) => m && TAGS.includes(m[1]))
    .map((m) => ({ tag: m[1], text: m[2].trim() }));
}

/** The `- [target] …` lines under a retro.md's Lessons. */
export function lessonsOf(markdown) {
  return section(markdown, 'Lessons').split('\n')
    .map((l) => /^\s*[-*]\s+\[([^\]]+)\]\s*(.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ target: m[1].trim(), text: m[2].trim() }));
}

/** Job ids that earlier reports in factory/retros/ list on their `Jobs:` line. */
export function reportedJobs(root) {
  const dir = join(root, 'factory/retros');
  const out = new Set();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const line = /^Jobs:\s*(.*)$/m.exec(readText(join(dir, name)) ?? '')?.[1] ?? '';
    for (const id of line.split(/[\s,]+/).filter(Boolean)) out.add(id);
  }
  return out;
}

const usd = (n) => `$${(n || 0).toFixed(2)}`;
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

/** The most recent `last` retros (by when they were prepared), tallied as markdown. */
export function summarize(root, { last = 20 } = {}) {
  const jobs = readBoard(root).jobs.filter((j) => !ACTIVE.has(j.stage));
  const retros = jobs
    .map((j) => {
      const p = retroPaths(root, j.id);
      const facts = readJson(p.json);
      return facts && { facts, md: readText(p.md) ?? '', at: Date.parse(facts.preparedAt) || statSync(p.json).mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, last);
  if (!retros.length) return '# Retro summary\n\nNo retros yet. A retro runs when a job ships, or with `/factory retro <job-id>`.\n';

  const reported = reportedJobs(root);
  const fresh = retros.filter((r) => !reported.has(r.facts.job));
  const out = ['# Retro summary', '',
    `${retros.length} job${retros.length > 1 ? 's' : ''}, ${fresh.length} not in an earlier report: ${retros.map((r) => r.facts.job).join(', ')}`, ''];

  const byTag = new Map();
  for (const r of retros) {
    for (const c of causesOf(r.md)) {
      const t = byTag.get(c.tag) || { jobs: new Set(), items: [] };
      t.jobs.add(r.facts.job);
      t.items.push(`${r.facts.job}: ${c.text}`);
      byTag.set(c.tag, t);
    }
  }
  const tags = [...byTag.entries()].sort((a, b) => b[1].jobs.size - a[1].jobs.size || a[0].localeCompare(b[0]));
  out.push('## Causes', '');
  if (!tags.length) out.push('None recorded.', '');
  else {
    out.push(table(['Cause', 'Jobs', 'New', 'Which'], tags.map(([tag, t]) => [
      `\`${tag}\``, t.jobs.size, [...t.jobs].filter((id) => !reported.has(id)).length, [...t.jobs].join(', ')])), '');
    for (const [tag, t] of tags) out.push(`### \`${tag}\``, '', ...t.items.map((i) => `- ${i}`), '');
  }

  const byTarget = new Map();
  for (const r of retros) {
    for (const l of lessonsOf(r.md)) {
      if (!byTarget.has(l.target)) byTarget.set(l.target, []);
      byTarget.get(l.target).push(`(${r.facts.job}${reported.has(r.facts.job) ? '' : ', new'}) ${l.text}`);
    }
  }
  out.push('## Lessons by target', '');
  if (!byTarget.size) out.push('None recorded.', '');
  for (const [target, items] of [...byTarget.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`### ${target}`, '', ...items.map((i) => `- ${i}`), '');
  }

  const totals = {};
  for (const r of retros) {
    for (const [name, t] of Object.entries(r.facts.reviewers || {})) {
      const s = (totals[name] ||= { reviews: 0, changes: 0, blocking: 0, disputed: 0, conceded: 0 });
      for (const k of Object.keys(s)) s[k] += t[k] || 0;
    }
  }
  out.push('## Reviewers', '',
    'Disputed: blocking findings the builder answered with "not changed". Conceded: of those, the ones the reviewer passed next round.', '',
    table(['Reviewer', 'Reviews', 'Asked for changes', 'Blocking findings', 'Disputed', 'Conceded'],
      Object.entries(totals).sort((a, b) => a[0].localeCompare(b[0])).map(([name, s]) =>
        [name, s.reviews, s.changes, s.blocking, s.disputed, s.conceded])), '');

  out.push('## Jobs', '', table(['Job', 'Stage', 'Rounds', 'Check fixes', 'Human reworks', 'Shipped by', 'Cost', 'Clean'],
    retros.map(({ facts: f }) => [f.job, f.stage, f.round, (f.perRound || []).reduce((s, x) => s + (x.checkFixes || 0), 0),
      f.reworks, f.shippedBy || '—', usd(f.cost?.usd), f.clean ? 'yes' : 'no'])), '');
  return out.join('\n');
}

// ---------- entry point ----------

function main() {
  const [command, ...args] = process.argv.slice(2);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const stage = args[1] === '--stage' && args[2] ? args[2] : undefined;
  if (command === 'prepare' && (args.length === 1 || (args.length === 3 && stage))) {
    const facts = prepare(root, args[0], { stage });
    console.log(JSON.stringify({ ok: true, clean: facts.clean, why: facts.why, path: `factory/jobs/${args[0]}/retro.json` }));
  } else if (command === 'summary') {
    let last = 20;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--last') last = Number(args[++i]);
      else if (args[i].startsWith('--last=')) last = Number(args[i].slice(7));
      else throw new Error(`unknown argument ${args[i]}`);
    }
    if (!Number.isInteger(last) || last < 1) throw new Error('--last takes a whole number, 1 or more');
    process.stdout.write(summarize(root, { last }));
  } else {
    console.error('Usage: node retro.mjs prepare <job-id> [--stage <stage>] | summary [--last N]');
    process.exitCode = 2;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) { console.error(`retro.mjs: ${err.message}`); process.exitCode = 1; }
}
