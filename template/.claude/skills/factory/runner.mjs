#!/usr/bin/env node
// The factory's headless runner. It drives jobs from request to merge with no Claude
// Code session open: it does the bookkeeping itself (board, worktrees, checks,
// verdicts, retries, merges, GitHub) and calls a harness (harness/<name>.mjs) only to
// run the agents. The rules are SKILL.md's; this is the same loop in code.
//
//   node runner.mjs run [--parallel N] [--job <id>]   run jobs until nothing is left
//   node runner.mjs approve <job-id>                  ship a needs-human job
//   node runner.mjs rework <job-id> <note>            send a needs-human job back to the builder
//
// Each step is worked out from the job's files (nextAction), so a runner that is
// killed and started again carries on where it stopped.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimBacklogItem, claimJobId, getJob, lockHolder, lockPath, now, readBoard, readJson, slugify,
  tryLock, unlock, updateJob, withLockAsync, writeJsonAtomic,
} from './board.mjs';
import { rebuildSummary, recordRun, refreshJob } from './usage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACTIVE = new Set(['spec', 'build', 'review', 'approval']);
const CHECK_FIX_LIMIT = 2;
const TRIES = 2; // an agent that doesn't write its file runs once more
const UNCONFIGURED = '<!-- factory:unconfigured -->';
const HEARTBEAT_MS = 15_000; // how often factory/activity/<id>.json is rewritten while a step runs
const QUIET_MS = 60_000; // a step this long with no tool calls gets a "still working" line

const USAGE = `Usage:
  node runner.mjs run [--parallel N] [--job <id>]   run jobs until nothing is left
  node runner.mjs approve <job-id>                  ship a needs-human job
  node runner.mjs rework <job-id> <note>            send a needs-human job back to the builder`;

// ---------- files ----------

const readText = (path) => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

const firstLine = (path) => (readText(path) ?? '').split('\n', 1)[0].trim();

export function verdictOf(path) {
  return /^VERDICT:\s*(PASS|CHANGES)\b/.exec(firstLine(path))?.[1] || null;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
}

const gitTry = (args, cwd) => {
  try { return git(args, cwd); } catch { return null; }
};

const errorText = (err) => String([err.stderr, err.stdout, err.message].map((s) => String(s || '').trim()).find(Boolean) || err)
  .split('\n').filter(Boolean).pop()?.slice(0, 200) || 'unknown error';

export function paths(root, job) {
  const jobDir = join(root, 'factory/jobs', job.id);
  return {
    jobDir,
    request: join(jobDir, 'request.md'),
    spec: join(jobDir, 'spec.md'),
    build: join(jobDir, 'build.md'),
    decision: join(jobDir, 'decision.md'),
    project: join(root, 'factory/project.md'),
    contract: join(HERE, 'reviewer-contract.md'),
    worktree: join(root, '.factory-worktrees', job.id),
    round: (n) => join(jobDir, `round-${n}`),
  };
}

/** What the job's files say about how far it got. */
export function readFacts(root, config, job) {
  const p = paths(root, job);
  const n = job.round || 0;
  const branch = `factory/${job.id}`;
  const head = gitTry(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root) || null;
  const build = readText(p.build);
  const reviews = {};
  for (const name of job.reviewers || []) reviews[name] = verdictOf(join(p.round(n), `review-${name}.md`));
  const decision = readText(p.decision) ?? '';
  return {
    spec: existsSync(p.spec),
    worktree: existsSync(p.worktree),
    head,
    ahead: head ? Number(gitTry(['rev-list', '--count', `${config.baseBranch}..${branch}`], root) || 0) : 0,
    build: build !== null,
    responded: build !== null && new RegExp(`^## Round ${n} response\\b`, 'm').test(build),
    human: existsSync(join(p.round(n), 'human.md')),
    round: n ? readJson(join(p.round(n), 'round.json')) : null,
    reviews,
    decision: /^(APPROVE|ESCALATE)\b/.exec(decision.split('\n', 1)[0].trim())?.[1] || null,
    reason: /^Reason:\s*(.+)$/m.exec(decision)?.[1].trim() || null,
  };
}

// ---------- the loop ----------

/**
 * The next thing to do for a job, from its board entry and its files (readFacts).
 * Pure: the same rules as SKILL.md's Resume section, applied at every step.
 */
export function nextAction(job, f) {
  const n = job.round || 0;
  switch (job.stage) {
    case 'spec':
      return f.spec ? { type: 'worktree' } : { type: 'spec' };

    case 'build':
      if (!f.worktree) return { type: 'worktree' };
      if (f.human && !f.responded) return { type: 'build', step: 'rework' };
      if (n === 0) return f.build && f.ahead > 0 ? { type: 'round', n: 1 } : { type: 'build', step: 'first' };
      return f.responded ? { type: 'round', n: n + 1 } : { type: 'build', step: 'review' };

    case 'review': {
      if (!f.worktree) return { type: 'worktree' };
      const r = f.round;
      // No result for this round yet, or a check fix has committed since it ran.
      if (!r || r.round !== n || (!r.checks.ok && r.sha !== f.head)) return { type: 'checks', n };
      if (!r.checks.ok) {
        const failed = r.checks.dirty ? ['uncommitted changes'] : r.checks.results.filter((c) => c.exit !== 0).map((c) => c.name);
        return (job.runner?.checkFixes?.[n] || 0) >= CHECK_FIX_LIMIT
          ? { type: 'needs-human', note: `checks still failing: ${failed.join(', ')}` }
          : { type: 'build', step: 'checkfix' };
      }
      const ran = Object.entries(r.reviewers || {}).filter(([, x]) => x.run);
      const missing = ran.filter(([name]) => !f.reviews[name]);
      if (missing.length) return { type: 'review', n, reviewers: missing.map(([name, x]) => ({ name, model: x.model })) };
      const changes = ran.filter(([name]) => f.reviews[name] === 'CHANGES').map(([name]) => name);
      if (!changes.length) return { type: 'stage', stage: 'approval' };
      return n < job.roundLimit
        ? { type: 'stage', stage: 'build' }
        : { type: 'needs-human', note: `still CHANGES after ${n} rounds: ${changes.join(', ')}` };
    }

    case 'approval':
      if (f.decision === 'APPROVE') return { type: 'ship' };
      if (f.decision === 'ESCALATE') return { type: 'needs-human', note: f.reason || 'the approver escalated', decision: 'ESCALATE' };
      return { type: 'approver' };

    default:
      return null;
  }
}

// ---------- prompts ----------

// The same prompts SKILL.md gives. Every path is absolute; agents reply with one line.
export const prompts = {
  spec: (p, job) => [
    `Write the spec for factory job ${job.id}: ${job.title}.`,
    `- Request: ${p.request}`,
    `- Project profile: ${p.project}`,
    `- Job folder: ${p.jobDir}/`,
    `- Output: ${p.spec}`,
    'Reply with one line.',
  ].join('\n'),

  builder: (p, job, base, step, built) => {
    const n = job.round || 0;
    const round = p.round(n);
    const task = {
      first: 'First build: implement the spec with tests, commit on the branch, write build.md, and reply with one line.',
      checkfix: `Check fix: the checks failed on the last commit; the output is in \`${join(round, 'round.md')}\`. Fix the cause, commit, and reply with one line.`,
      review: `Round ${n} reviews are in \`${round}/\`. Address every CHANGES finding, commit, append a \`## Round ${n} response\` section to build.md, and reply with one line.`,
      rework: `Rework: human feedback is in \`${join(round, 'human.md')}\`; read \`decision.md\` and any \`review-*.md\` there too. Address it, commit, append a \`## Round ${n} response\` section to build.md, and reply with one line.`,
    }[step];
    return [
      `Factory job ${job.id}: ${job.title}.`,
      `- Worktree: ${p.worktree} (branch factory/${job.id}, baseBranch ${base})`,
      `- Job folder: ${p.jobDir}/`,
      `- Spec: ${p.spec}`,
      `- Project profile: ${p.project}`,
      built ? `- Build notes: ${p.build}` : `- Build notes (you write this): ${p.build}`,
      '',
      task,
    ].join('\n');
  },

  reviewer: (p, job, base, name, n) => [
    `Review round ${n} of factory job ${job.id}: ${job.title}.`,
    `- Reviewer contract: ${p.contract}`,
    `- Job folder: ${p.jobDir}/`,
    `- Spec: ${p.spec}`,
    `- Build notes: ${p.build}`,
    `- Project profile: ${p.project}`,
    `- Worktree: ${p.worktree} (branch factory/${job.id}, baseBranch ${base})`,
    `- Round file: ${join(p.round(n), 'round.md')}`,
    `- Output: ${join(p.round(n), `review-${name}.md`)}`,
    'Reply with one line.',
  ].join('\n'),

  approver: (p, job, base) => [
    `Decide factory job ${job.id}: ${job.title}.`,
    `- Job folder: ${p.jobDir}/`,
    `- Worktree: ${p.worktree}`,
    `- Branch: factory/${job.id}`,
    `- Base branch: ${base}`,
    `- Final round file: ${join(p.round(job.round || 0), 'round.md')}`,
    `- Project profile: ${p.project}`,
    `- Output: ${p.decision}`,
    'Reply with one line.',
  ].join('\n'),
};

/** The tools an agent's definition lists in its frontmatter. */
export function agentTools(root, agent) {
  const text = readText(join(root, '.claude/agents', `factory-${agent}.md`)) ?? '';
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  return (/^tools:\s*(.+)$/m.exec(front)?.[1] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

// ---------- actions ----------

/** Runs an agent until done() holds, at most TRIES times. Records its cost each time. */
async function agentStep(ctx, job, { agent, model, prompt, round = null, done }) {
  const { root, config, signal } = ctx;
  const p = paths(root, job);
  // Paths in the worktree or repo read relative to it.
  const short = (text, max = 120) => {
    const s = String(text).split(`${p.worktree}/`).join('').split(`${root}/`).join('');
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    signal.throwIfAborted();
    ctx.log(job.id, `${agent} started (${model})`);
    const step = begin(ctx, job.id, agent, model);
    let release = () => {};
    const result = await ctx.harness.runAgent({
      root, agent, model, prompt, tools: agentTools(root, agent), options: config.runner, signal,
      onSpawn: (pid) => { release = track(ctx, job.id, pid); },
      onActivity: (text) => step.note(short(text)),
    }).finally(() => { release(); step.end(); });
    if (!signal.aborted && result.ok) {
      const reply = result.reply?.split('\n', 1)[0];
      ctx.log(job.id, `${agent} finished in ${elapsed(step.startedAt)}${reply ? `: ${short(reply, 160)}` : ''}`);
    }
    if (result.sessionId) {
      try {
        recordRun(root, { job: job.id, agentType: `factory-${agent}`, agentId: result.sessionId, round, usage: result.usage }, config.pricing);
        rebuildSummary(root);
      } catch (err) { ctx.log(job.id, `couldn't record ${agent}'s cost: ${err.message}`); }
    }
    signal.throwIfAborted();
    if (done()) return true;
    ctx.log(job.id, `${agent}: ${result.error || "didn't write its file"}${attempt < TRIES ? '; running it again' : ''}`);
  }
  return false;
}

async function perform(ctx, job, action, facts) {
  const { root, config, signal } = ctx;
  const id = job.id;
  const base = config.baseBranch;
  const p = paths(root, job);
  const n = job.round || 0;

  switch (action.type) {
    case 'spec': {
      const ok = await agentStep(ctx, job, {
        agent: 'spec-writer', model: config.models['spec-writer'], prompt: prompts.spec(p, job), done: () => existsSync(p.spec),
      });
      if (!ok) await needsHuman(ctx, id, 'the spec-writer wrote no spec.md');
      return;
    }

    case 'worktree':
      await ctx.git(() => {
        if (existsSync(p.worktree)) return; // added just before a restart
        gitTry(['worktree', 'prune'], root);
        if (facts.head) git(['worktree', 'add', p.worktree, `factory/${id}`], root);
        else git(['worktree', 'add', p.worktree, '-b', `factory/${id}`, base], root);
      });
      if (job.stage === 'spec') updateJob(root, id, { stage: 'build' });
      ctx.log(id, `worktree ready on factory/${id}`);
      return;

    case 'build': {
      const { step } = action;
      const before = facts.head;
      const model = step === 'first' || step === 'rework'
        ? config.models.builder
        : config.models['builder-fix'] || config.models.builder;
      const ok = await agentStep(ctx, job, {
        agent: 'builder', model, round: step === 'first' ? null : n,
        prompt: prompts.builder(p, job, base, step, facts.build),
        done: () => {
          const g = readFacts(root, config, getJob(root, id));
          if (step === 'first') return g.build && g.ahead > 0;
          return g.head !== before && (step === 'checkfix' || g.responded);
        },
      });
      if (!ok) {
        const what = {
          first: 'the builder wrote no build.md or made no commits',
          checkfix: `the builder made no commits to fix the round ${n} checks`,
          review: `the builder didn't commit and answer round ${n} in build.md`,
          rework: `the builder didn't commit and answer the rework in build.md`,
        }[step];
        await needsHuman(ctx, id, what);
      } else if (step === 'checkfix') {
        updateJob(root, id, (j) => {
          j.runner ||= {};
          j.runner.checkFixes ||= {};
          j.runner.checkFixes[n] = (j.runner.checkFixes[n] || 0) + 1;
        });
      }
      return;
    }

    case 'round':
      updateJob(root, id, (j) => {
        j.round = action.n;
        j.rounds = (j.rounds || []).slice(0, action.n - 1);
        j.rounds[action.n - 1] = Object.fromEntries((j.reviewers || []).map((r) => [r, 'pending']));
        j.stage = 'review';
        j.note = null;
      });
      ctx.log(id, `round ${action.n} started`);
      return;

    case 'checks': {
      const names = Object.keys(config.checks || {});
      ctx.log(id, `round ${action.n}: running checks${names.length ? ` (${names.join(', ')})` : ''}`);
      const out = await ctx.checks(() => {
        signal.throwIfAborted(); // queued while the runner was stopped
        const step = begin(ctx, id, 'checks', null, names.join(', ') || null);
        let release = () => {};
        return runNode(join(HERE, 'round.mjs'), [id, String(action.n)], {
          cwd: root, signal, onSpawn: (pid) => { release = track(ctx, id, pid); },
        }).finally(() => { release(); step.end(); });
      });
      signal.throwIfAborted();
      if (out.code !== 0) return needsHuman(ctx, id, out.stderr.trim().split('\n').pop() || `round.mjs exited ${out.code}`);
      const summary = JSON.parse(out.stdout.trim().split('\n').pop());
      if (!summary.ok) return ctx.log(id, `round ${action.n}: checks failed (${summary.failed.join(', ')})`);
      updateJob(root, id, (j) => {
        const verdicts = (j.rounds[action.n - 1] ||= {});
        for (const name of summary.skipped) verdicts[name] = 'SKIPPED';
      });
      ctx.log(id, `round ${action.n}: checks passed; reviewers: ${summary.run.map((r) => `${r.name} (${r.model})`).join(', ') || 'none'}`);
      return;
    }

    case 'review': {
      // WAIT FOR ALL: every reviewer in the round finishes before anything else happens.
      const missed = await Promise.all(action.reviewers.map(async ({ name, model }) => {
        const out = join(p.round(action.n), `review-${name}.md`);
        const ok = await agentStep(ctx, job, {
          agent: `review-${name}`, model, round: action.n,
          prompt: prompts.reviewer(p, job, base, name, action.n),
          done: () => verdictOf(out) !== null,
        });
        const verdict = verdictOf(out);
        if (verdict) {
          updateJob(root, id, (j) => { (j.rounds[action.n - 1] ||= {})[name] = verdict; });
          ctx.log(id, `round ${action.n}: ${name} ${verdict}`);
        }
        return ok ? null : name;
      }));
      const names = missed.filter(Boolean);
      if (names.length) await needsHuman(ctx, id, `reviewer ${names.join(', ')} produced no verdict in round ${action.n}`);
      return;
    }

    case 'stage':
      updateJob(root, id, { stage: action.stage, note: null });
      ctx.log(id, `stage ${action.stage}`);
      return;

    case 'approver': {
      const ok = await agentStep(ctx, job, {
        agent: 'approver', model: config.models.approver, prompt: prompts.approver(p, job, base),
        done: () => readFacts(root, config, job).decision !== null,
      });
      if (!ok) await needsHuman(ctx, id, 'the approver wrote no decision.md');
      return;
    }

    case 'ship':
      updateJob(root, id, { decision: 'APPROVE' });
      return ship(ctx, id, `APPROVE: ${facts.reason || 'approved'}`);

    case 'needs-human':
      return needsHuman(ctx, id, action.note, action.decision ? { decision: action.decision } : {});

    default:
      throw new Error(`unknown action ${action.type}`);
  }
}

async function needsHuman(ctx, id, note, extra = {}) {
  const job = updateJob(ctx.root, id, { stage: 'needs-human', note, ...extra });
  ctx.log(id, `needs a human: ${note}`);
  finishUsage(ctx, id);
  await ctx.gh.comment(job, `Factory job ${id} needs a human: ${note}. Details in factory/jobs/${id}/.`);
}

// A job left the active stages: re-read its transcripts so the last messages count.
function finishUsage(ctx, id) {
  try {
    refreshJob(ctx.root, id, ctx.config.pricing);
    rebuildSummary(ctx.root);
  } catch { /* cost records never fail a job */ }
}

// ---------- ship ----------

/** SKILL.md's Ship: merge (or open a PR), clean up, record. One at a time per repo. */
async function ship(ctx, id, approval) {
  const job = getJob(ctx.root, id);
  if (ctx.config.onApprove === 'pr') return shipPr(ctx, job, approval);
  const { root, config } = ctx;
  const base = config.baseBranch;
  const branch = `factory/${id}`;
  const record = `factory/jobs/${id}`;
  return ctx.git(async () => {
    // The merge is checkpointed on the board before anything is cleaned up, so a ship
    // that stopped part-way carries on from here instead of merging again.
    let sha = getJob(root, id).runner?.merged;
    if (!sha) {
      if (gitTry(['merge-base', '--is-ancestor', branch, base], root) === null) {
        const current = gitTry(['symbolic-ref', '--short', 'HEAD'], root);
        if (current !== base) return needsHuman(ctx, id, `check out ${base}, then /factory approve ${id}`);
        const closes = job.issue ? ` (closes #${job.issue})` : '';
        try {
          git(['merge', '--no-ff', branch, '-m', `factory: merge ${id} — ${job.title}${closes}`], root);
        } catch (err) {
          if (gitTry(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root)) gitTry(['merge', '--abort'], root);
          return needsHuman(ctx, id, `merge failed: ${errorText(err)}`);
        }
      }
      sha = gitTry(['rev-parse', '--short', base], root);
      updateJob(root, id, (j) => { (j.runner ||= {}).merged = sha; });
    }
    removeWorktree(ctx, id);
    if (gitTry(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root) && gitTry(['branch', '-d', branch], root) === null) {
      ctx.log(id, `couldn't delete ${branch}; delete it by hand`);
    }
    finishUsage(ctx, id);
    try {
      git(['add', record], root);
      // Nothing staged means it's recorded already (a retried ship).
      if (gitTry(['diff', '--cached', '--quiet', '--', record], root) === null) {
        git(['commit', '-q', '-m', `factory: record job ${id}`, '--', record], root);
      }
    } catch (err) {
      return needsHuman(ctx, id, `merged as ${sha}, but committing ${record} failed: ${errorText(err)}. Fix that, then /factory approve ${id}`);
    }
    const done = updateJob(root, id, { stage: 'merged', note: null });
    ctx.log(id, `merged into ${base} as ${sha}`);
    await ctx.gh.comment(done, `Merged into ${base} locally as ${sha}. This issue closes when ${base} is pushed.`);
    await ctx.gh.unlabel(done);
  });
}

async function shipPr(ctx, job, approval) {
  const { root, config } = ctx;
  const branch = `factory/${job.id}`;
  let url;
  try {
    git(['push', '-u', 'origin', branch], root);
    const dir = mkdtempSync(join(tmpdir(), 'factory-pr-'));
    try {
      writeFileSync(join(dir, 'body.md'), prBody(root, job, approval));
      url = (await ctx.gh.run(['pr', 'create', '--base', config.baseBranch, '--head', branch,
        '--title', job.title, '--body-file', join(dir, 'body.md')])).trim().split('\n').pop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    return needsHuman(ctx, job.id, errorText(err));
  }
  removeWorktree(ctx, job.id);
  const done = updateJob(root, job.id, { stage: 'pr-open', prUrl: url, note: null });
  finishUsage(ctx, job.id);
  ctx.log(job.id, `opened ${url} (the job record in factory/jobs/${job.id}/ is uncommitted)`);
  await ctx.gh.comment(done, `Opened ${url}.`);
  await ctx.gh.unlabel(done);
}

function removeWorktree(ctx, id) {
  const wt = join(ctx.root, '.factory-worktrees', id);
  if (existsSync(wt) && gitTry(['worktree', 'remove', wt], ctx.root) === null) {
    ctx.log(id, `couldn't remove the worktree at ${wt} (uncommitted files?); remove it by hand`);
  }
}

function section(markdown, heading) {
  const m = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(markdown);
  return m ? m[1].trim() : '';
}

export function prBody(root, job, approval) {
  const p = paths(root, job);
  const spec = readText(p.spec) ?? '';
  const latest = {};
  for (const round of job.rounds || []) {
    for (const [name, v] of Object.entries(round || {})) if (v === 'PASS' || v === 'CHANGES') latest[name] = v;
  }
  return [
    '## Goal', '', section(spec, 'Goal') || '—', '',
    '## Acceptance criteria', '', section(spec, 'Acceptance criteria') || '—', '',
    '## Reviews', '', ...(job.reviewers || []).map((name) => `- ${name}: ${latest[name] || 'skipped'}`), '',
    `**Approval:** ${approval}`,
    ...(job.issue ? ['', `Closes #${job.issue}`] : []),
    '',
  ].join('\n');
}

// ---------- GitHub ----------

// A failing GitHub command never fails a job (except opening a PR): it's logged.
function github(ctx) {
  const label = ctx.config.tasks?.githubLabel || 'factory';
  const run = (args) => new Promise((ok, fail) => {
    execFile('gh', args, { cwd: ctx.root, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) fail(Object.assign(err, { stderr }));
      else ok(stdout);
    });
  });
  const quiet = async (job, args) => {
    try { await run(args); } catch (err) { ctx.log(job.id, `GitHub: ${errorText(err)}`); }
  };
  return {
    run,
    label,
    comment: (job, body) => job.issue ? quiet(job, ['issue', 'comment', String(job.issue), '--body', body]) : undefined,
    unlabel: (job) => job.issue ? quiet(job, ['issue', 'edit', String(job.issue), '--remove-label', `${label}-in-progress`]) : undefined,
    async claim(job) {
      await run(['label', 'create', `${label}-in-progress`]).catch(() => {}); // already exists
      await quiet(job, ['issue', 'edit', String(job.issue), '--add-label', `${label}-in-progress`]);
      await quiet(job, ['issue', 'comment', String(job.issue), '--body', `🏭 Factory started job ${job.id} on branch factory/${job.id}.`]);
    },
  };
}

// ---------- tasks ----------

function enabledReviewers(config) {
  return Object.entries(config.reviewers || {}).filter(([, r]) => r.enabled !== false).map(([name]) => name);
}

function createJob(ctx, { id, title, request, issue = null, pendingBacklogItem }) {
  const { root, config } = ctx;
  writeFileSync(join(root, 'factory/jobs', id, 'request.md'), request.endsWith('\n') ? request : `${request}\n`);
  return updateJob(root, id, {
    title: title.slice(0, 80),
    branch: `factory/${id}`,
    worktree: `.factory-worktrees/${id}`,
    stage: 'spec',
    round: 0,
    roundLimit: config.maxRounds,
    reviewers: enabledReviewers(config),
    rounds: [],
    decision: null,
    issue: issue?.number ?? null,
    issueUrl: issue?.url ?? null,
    note: null,
    prUrl: null,
    ...(pendingBacklogItem ? { pendingBacklogItem } : {}),
  });
}

/** Starts the next task from config.tasks.source, as SKILL.md's Next does. Returns its job id, or null. */
async function claimNext(ctx) {
  const { root, config } = ctx;
  if ((config.tasks?.source || 'backlog') === 'backlog') {
    // The job is created before its item is ticked off. A job still marked
    // pendingBacklogItem took its item before a crash stopped the tick: tick it for that
    // job (which runs as an active job) rather than starting it twice.
    const settled = [];
    const item = claimBacklogItem(root, ({ text, request }) => {
      const orphan = readBoard(root).jobs.find((j) => j.pendingBacklogItem === text);
      if (orphan) {
        settled.push(orphan.id);
        return { id: orphan.id, existing: true };
      }
      const id = claimJobId(root, slugify(text));
      createJob(ctx, { id, title: text, request, pendingBacklogItem: text });
      settled.push(id);
      return { id };
    });
    for (const id of settled) updateJob(root, id, (j) => { delete j.pendingBacklogItem; });
    if (!item) return null;
    ctx.log(item.id, 'claimed from the backlog');
    return item.id;
  }

  const label = ctx.gh.label;
  let issue;
  try {
    const taken = new Set(readBoard(root).jobs.filter((j) => j.issue && j.stage !== 'failed').map((j) => j.issue));
    const open = JSON.parse(await ctx.gh.run(['issue', 'list', '--state', 'open', '--label', label, '--limit', '100',
      '--json', 'number,title,labels,createdAt,url']));
    const next = open
      .filter((i) => !i.labels.some((l) => l.name === `${label}-in-progress`) && !taken.has(i.number))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
    if (!next) return null;
    issue = JSON.parse(await ctx.gh.run(['issue', 'view', String(next.number), '--json', 'number,title,body,url,state,comments']));
  } catch (err) {
    ctx.log('github', `couldn't list issues: ${errorText(err)}`);
    return null;
  }
  // Only comments from people with write access are part of the request.
  const comments = (issue.comments || [])
    .filter((c) => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.authorAssociation))
    .map((c) => `\n---\n${c.author?.login || 'someone'} (${c.createdAt}):\n\n${c.body.trim()}\n`);
  const request = `# ${issue.title}\nSource: ${issue.url}\n\n${(issue.body || '').trim()}\n${comments.join('')}`;
  const id = claimJobId(root, slugify(issue.title));
  const job = createJob(ctx, { id, title: issue.title, request, issue });
  await ctx.gh.claim(job);
  ctx.log(id, `claimed issue #${issue.number}`);
  return id;
}

// ---------- running ----------

function preflight(ctx) {
  const { root, config } = ctx;
  const problems = [];
  if ((readText(join(root, 'factory/project.md')) ?? UNCONFIGURED).includes(UNCONFIGURED)) {
    problems.push('factory/project.md isn\'t set up yet: run /factory setup in Claude Code first.');
  }
  if (!gitTry(['rev-parse', '--verify', '--quiet', `refs/heads/${config.baseBranch}`], root)) {
    problems.push(`baseBranch "${config.baseBranch}" (factory/config.json) isn't a local branch.`);
  }
  for (const agent of ['spec-writer', 'builder', 'approver', ...enabledReviewers(config).map((n) => `review-${n}`)]) {
    if (!existsSync(join(root, '.claude/agents', `factory-${agent}.md`))) problems.push(`.claude/agents/factory-${agent}.md is missing.`);
  }
  const harness = ctx.harness.preflight?.(config.runner);
  if (harness) problems.push(harness);
  if (problems.length) throw new Error(problems.join('\n'));
  if (!Object.keys(config.checks || {}).length) {
    ctx.log('runner', 'config.checks is empty, so no checks run between the builder and the reviewers');
  }
}

/**
 * Takes a job's lock, so no other process drives or changes it, and stops any agents
 * or checks a crashed runner left running for it. False if a live process has it.
 */
async function ownJob(ctx, id) {
  if (!tryLock(lockPath(ctx.root, `job-${id}`))) return false;
  await reapOrphans(ctx, id);
  return true;
}

/** Drives one job until it leaves the active stages. Only one process drives a job at a time. */
async function drive(ctx, id, { locked = false } = {}) {
  const lock = lockPath(ctx.root, `job-${id}`);
  if (!locked && !(await ownJob(ctx, id))) {
    ctx.log(id, 'another process is running this job; leaving it to that one');
    return;
  }
  try {
    for (;;) {
      ctx.signal.throwIfAborted();
      let job = getJob(ctx.root, id);
      if (!job || !ACTIVE.has(job.stage)) return;
      const facts = readFacts(ctx.root, ctx.config, job);
      job = reconcile(ctx, job, facts);
      const action = nextAction(job, facts);
      if (!action) return;
      try {
        await perform(ctx, job, action, facts);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        await needsHuman(ctx, id, `runner error: ${errorText(err)}`);
      }
    }
  } catch (err) {
    if (!ctx.signal.aborted) throw err;
  } finally {
    rmSync(activityFile(ctx.root, id), { force: true });
    if (!locked) unlock(lock);
  }
}

// ---------- what's running now ----------

// factory/activity/<id>.json says what a job's agents and checks are doing, for the
// dashboard. Only the process holding the job's lock writes it. It's rewritten every
// HEARTBEAT_MS while anything runs, so a file whose updatedAt has gone stale was left
// by a runner that stopped.
export const activityFile = (root, id) => join(root, 'factory/activity', `${id}.json`);

const elapsed = (since) => {
  const s = Math.round((Date.now() - since) / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
};

function saveActivity(ctx, id) {
  const steps = [...(ctx.activity.get(id) || [])];
  try {
    if (!steps.length) return rmSync(activityFile(ctx.root, id), { force: true });
    writeJsonAtomic(activityFile(ctx.root, id), {
      pid: process.pid,
      updatedAt: now(),
      steps: steps.map((s) => ({
        name: s.name, model: s.model, startedAt: new Date(s.startedAt).toISOString(),
        last: s.last, lastAt: s.lastAt ? new Date(s.lastAt).toISOString() : null,
      })),
    });
  } catch { /* progress never fails a job */ }
}

/** Starts showing a step (an agent, or the checks) as running for a job. */
function begin(ctx, id, name, model = null, last = null) {
  const step = { name, model, startedAt: Date.now(), last, lastAt: null, quietFrom: Date.now() };
  const steps = ctx.activity.get(id) || new Set();
  ctx.activity.set(id, steps.add(step));
  saveActivity(ctx, id);
  ctx.heartbeat ||= setInterval(() => heartbeat(ctx), HEARTBEAT_MS).unref();
  return {
    startedAt: step.startedAt,
    note(text) {
      step.last = text;
      step.lastAt = step.quietFrom = Date.now();
      ctx.log(id, `${name}: ${text}`);
      saveActivity(ctx, id);
    },
    end() {
      steps.delete(step);
      if (!steps.size) ctx.activity.delete(id);
      saveActivity(ctx, id);
      if (!ctx.activity.size) ctx.heartbeat = clearInterval(ctx.heartbeat);
    },
  };
}

// Keeps the activity files fresh, and says so in the log when a step has gone quiet
// (a long test run, or the model thinking), so a quiet runner never looks stuck.
function heartbeat(ctx) {
  for (const [id, steps] of ctx.activity) {
    for (const s of steps) {
      if (Date.now() - s.quietFrom < QUIET_MS) continue;
      s.quietFrom = Date.now();
      ctx.log(id, `${s.name} still working (${elapsed(s.startedAt)}${s.last ? `; last: ${s.last}` : ''})`);
    }
    saveActivity(ctx, id);
  }
}

/**
 * Puts the current round's verdicts from its files onto the board, in case the runner
 * stopped after a reviewer or round.mjs wrote its file but before the board was updated.
 */
export function reconcile(ctx, job, facts) {
  const n = job.round || 0;
  const r = facts.round;
  if (!n || !r?.checks?.ok || r.round !== n || !r.reviewers) return job;
  const want = Object.fromEntries((job.reviewers || []).map((name) => [name,
    !r.reviewers[name]?.run ? 'SKIPPED' : facts.reviews[name] || 'pending']));
  if (JSON.stringify(job.rounds?.[n - 1]) === JSON.stringify(want)) return job;
  return updateJob(ctx.root, job.id, (j) => { (j.rounds ||= [])[n - 1] = want; });
}

// ---------- agents a crashed runner left behind ----------

// Each job's running agents and checks, by process group, in factory/.locks/job-<id>.agents.
// A clean stop empties it; after a crash it names what's still running.
const agentsFile = (ctx, id) => `${lockPath(ctx.root, `job-${id}`)}.agents`;

function track(ctx, id, pid) {
  const running = (ctx.children[id] ||= new Set());
  const save = () => writeFileSync(agentsFile(ctx, id), [...running].join('\n'));
  running.add(pid);
  save();
  return () => {
    running.delete(pid);
    save();
  };
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

async function reapOrphans(ctx, id) {
  const pids = (readText(agentsFile(ctx, id)) ?? '').split('\n').map(Number).filter((pid) => pid > 0 && alive(pid));
  for (const pid of pids) {
    ctx.log(id, `stopping agent process ${pid}, left running by a runner that stopped`);
    try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
  }
  for (let waited = 0; pids.some(alive) && waited < 10_000; waited += 100) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter(alive)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  }
  rmSync(agentsFile(ctx, id), { force: true });
}

/** Resumes active jobs and claims new tasks, keeping up to `parallel` going, until none are left. */
async function runAll(ctx, parallel) {
  const lock = lockPath(ctx.root, 'runner');
  if (!tryLock(lock)) {
    let pid = '?';
    try { pid = lockHolder(lock); } catch { /* just released */ }
    throw new Error(`A runner is already running in this repo (pid ${pid}).`);
  }
  try {
    preflight(ctx);
    const running = new Map();
    const started = new Set();
    for (;;) {
      while (running.size < parallel && !ctx.signal.aborted) {
        const adopt = readBoard(ctx.root).jobs.find((j) => ACTIVE.has(j.stage) && !started.has(j.id));
        if (adopt) ctx.log(adopt.id, `resuming at stage ${adopt.stage}`);
        const id = adopt?.id || await claimNext(ctx);
        if (!id) break;
        started.add(id);
        running.set(id, drive(ctx, id)
          .catch((err) => ctx.log(id, `stopped: ${errorText(err)}`))
          .finally(() => running.delete(id)));
      }
      if (!running.size) break;
      await Promise.race(running.values());
    }
    if (!ctx.signal.aborted) ctx.log('runner', 'nothing left to run');
  } finally {
    unlock(lock);
  }
}

function limiter(max) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active < max) active++;
    else await new Promise((r) => waiting.push(r)); // the slot is handed over, not re-counted
    try { return await fn(); } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// round.mjs runs as a child process, in its own process group so stopping the runner
// also stops the checks it started, and with no time limit.
function runNode(script, args, { cwd, signal, onSpawn }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) onSpawn?.(child.pid);
    let stdout = '';
    let stderr = '';
    const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill(); // aborted already: the listener won't fire
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += err.message; });
    child.on('close', (code) => {
      signal.removeEventListener('abort', kill);
      done({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function loadHarness(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`config.runner.harness "${name}" isn't a harness name`);
  const file = join(HERE, 'harness', `${name}.mjs`);
  if (!existsSync(file)) throw new Error(`no harness "${name}" (expected ${file})`);
  return import(new URL(`./harness/${name}.mjs`, import.meta.url));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rest[++i]);
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--parallel' || arg.startsWith('--parallel=')) {
      opts.parallel = Number(value());
      if (!Number.isInteger(opts.parallel) || opts.parallel < 1) throw new Error('--parallel takes a whole number, 1 or more');
    } else if (arg === '--job' || arg.startsWith('--job=')) {
      opts.job = value();
      if (!opts.job || opts.job.startsWith('-')) throw new Error('--job takes a job id');
    }
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
    else opts.positional.push(arg);
  }
  return opts;
}

/**
 * Runs a runner command. Returns the exit code. `root` is the repo root; `log` gets
 * each line of progress.
 */
export async function main(argv, { root, log = console.log, error = console.error } = {}) {
  const controller = new AbortController();
  const stop = () => {
    if (controller.signal.aborted) process.exit(130);
    log('Stopping the agents. Run the same command again to carry on.');
    controller.abort();
  };
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help || !['run', 'approve', 'rework'].includes(opts.command)) {
      (opts.help ? log : error)(USAGE);
      return opts.help ? 0 : 2;
    }
    root ||= git(['rev-parse', '--show-toplevel'], HERE);
    const file = readJson(join(root, 'factory/config.json'));
    if (!file) throw new Error('factory/config.json is missing or not valid JSON');
    const config = {
      ...file,
      models: { 'spec-writer': 'opus', builder: 'opus', approver: 'opus', ...file.models },
      runner: { harness: 'claude-code', parallel: 1, maxParallelChecks: 1, permissionMode: 'dontAsk', ...file.runner },
    };
    const ctx = {
      root, config,
      signal: controller.signal,
      harness: await loadHarness(config.runner.harness),
      checks: limiter(Math.max(1, config.runner.maxParallelChecks)),
      git: (fn) => withLockAsync(lockPath(root, 'ship'), fn, { signal: controller.signal }),
      log: (id, line) => log(`[${id}] ${line}`),
      children: {},
      activity: new Map(),
      heartbeat: null,
    };
    ctx.gh = github(ctx);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    const [id, ...noteWords] = opts.positional;
    if (opts.command === 'run') {
      if (!opts.job) await runAll(ctx, opts.parallel || config.runner.parallel);
      else {
        const job = getJob(root, opts.job);
        if (!job) throw new Error(`No job ${opts.job} on the board.`);
        if (!ACTIVE.has(job.stage)) throw new Error(`Job ${opts.job} is ${job.stage}, so there's nothing to run.`);
        preflight(ctx);
        await drive(ctx, opts.job);
      }
    } else {
      if (!id || !getJob(root, id)) throw new Error(`No job ${id || '(none given)'} on the board.\n\n${USAGE}`);
      const note = noteWords.join(' ').trim();
      if (opts.command === 'rework' && !note) throw new Error(`Say what to change: rework ${id} <note>`);
      // Held for the whole command, so two approvals, or an approval and a rework, can't interleave.
      if (!(await ownJob(ctx, id))) throw new Error(`Job ${id} is being run by another process; try again when it stops.`);
      try {
        const job = getJob(root, id);
        if (job.stage !== 'needs-human') throw new Error(`Job ${id} is ${job.stage}; only a needs-human job can be ${opts.command === 'approve' ? 'approved' : 'reworked'}.`);
        if (opts.command === 'approve') {
          await ship(ctx, id, `approved by a human${job.note ? ` (it needed one because: ${job.note})` : ''}`);
        } else {
          preflight(ctx);
          const n = job.round || 0;
          const p = paths(root, job);
          mkdirSync(p.round(n), { recursive: true });
          writeFileSync(join(p.round(n), 'human.md'), `# Human feedback\n\n${note}\n`);
          if (existsSync(p.decision)) renameSync(p.decision, join(p.round(n), 'decision.md'));
          updateJob(root, id, { roundLimit: n + config.maxRounds, decision: null, note: null, stage: 'build' });
          await drive(ctx, id, { locked: true });
        }
      } finally {
        unlock(lockPath(root, `job-${id}`));
      }
    }
    return controller.signal.aborted ? 130 : 0;
  } catch (err) {
    if (controller.signal.aborted) return 130;
    error(err.message);
    return 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
