#!/usr/bin/env node
// Records what each factory agent used: tokens, estimated cost and active time.
//
//   node usage.mjs                    as a SubagentStop hook (hook input on stdin)
//   node usage.mjs refresh [job-id]   re-read the transcripts of one job, or all
//
// Writes factory/jobs/<id>/usage/<agent-id>.json per agent (kept with the job record)
// and rebuilds factory/usage.json, the summary the dashboard reads.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// USD per million tokens: input, output, cache read. Longest matching prefix wins.
// Cache writes cost 1.25x input (5-minute) or 2x input (1-hour). Override or add
// models with "pricing": { "<model prefix>": { "input": 4, "output": 20, "cacheRead": 0.2 } }
// in factory/config.json.
export const PRICES = {
  'claude-fable-5': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.1 },
};

const HOOK_FLUSH_MS = 1500; // transcripts are written asynchronously

export function priceFor(model, overrides = {}) {
  const table = { ...PRICES, ...overrides };
  const key = Object.keys(table).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : null;
}

/**
 * Sums a subagent transcript (JSONL). Returns per-model token counts, the active
 * seconds (time spent working, not waiting for its next instruction) and the first
 * prompt it was given.
 */
export function summarizeTranscript(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* partial line mid-write */ }
  }

  // One API response can span several lines with the same message id.
  const messages = new Map();
  for (const e of entries) {
    const m = e.type === 'assistant' && e.message;
    if (m && m.usage && m.model && !m.model.startsWith('<')) messages.set(m.id || e.uuid, m);
  }
  const models = {};
  for (const m of messages.values()) {
    const u = m.usage;
    const write = u.cache_creation_input_tokens || 0;
    const write1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
    const t = (models[m.model] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.cacheWrite1h += write1h;
    t.cacheWrite5m += write - write1h;
  }

  let active = 0;
  let prev = null;
  for (const e of entries) {
    const at = Date.parse(e.timestamp);
    if (!at) continue;
    if (prev !== null && !isInstruction(e)) active += Math.max(0, at - prev);
    prev = at;
  }

  const first = entries.find((e) => e.type === 'user');
  return { models, activeSeconds: Math.round(active / 1000), prompt: first ? contentText(first.message?.content) : '' };
}

// A new instruction (the first prompt, or SendMessage resuming the agent) rather than
// a tool result. The gap before one is time spent waiting, not working.
function isInstruction(e) {
  if (e.type !== 'user') return false;
  const c = e.message?.content;
  return typeof c === 'string' || (Array.isArray(c) && !c.some((b) => b.type === 'tool_result'));
}

function contentText(c) {
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
}

export function costOf(models, overrides) {
  let total = 0;
  const unpriced = [];
  const perModel = {};
  for (const [model, t] of Object.entries(models)) {
    const p = priceFor(model, overrides);
    if (!p) { unpriced.push(model); perModel[model] = { ...t, costUsd: null }; continue; }
    const usd = (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead
      + t.cacheWrite5m * p.input * 1.25 + t.cacheWrite1h * p.input * 2) / 1e6;
    perModel[model] = { ...t, costUsd: usd4(usd) };
    total += usd;
  }
  return { perModel, costUsd: usd4(total), unpriced };
}

const usd4 = (usd) => Math.round(usd * 10000) / 10000;
const tokensOf = (t) => t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;

export function jobOf(prompt) {
  return prompt.match(/factory\/jobs\/([A-Za-z0-9._-]+)/)?.[1] || null;
}

// A reviewer's round is in its output path. A builder follow-up (check fix, review
// round, rework) is pointed at the round folder it responds to.
export function roundOf(prompt, agent = '') {
  const m = prompt.match(/round-(\d+)\/review-/)
    || (agent.endsWith('builder') ? prompt.match(/round-(\d+)\//) : null);
  return m ? Number(m[1]) : null;
}

// ---------- files ----------

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

const home = homedir();
const shortPath = (p) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
const fullPath = (p) => (p.startsWith('~/') ? join(home, p.slice(2)) : p);

/** Reads one agent's transcript and writes its usage file. Returns the job id, or null. */
export function recordAgent(root, { agentId, agentType, transcript, job }, overrides) {
  const path = fullPath(transcript);
  if (!existsSync(path)) return null;
  const s = summarizeTranscript(readFileSync(path, 'utf8'));
  const id = job || jobOf(s.prompt);
  if (!id || !existsSync(join(root, 'factory/jobs', id))) return null;

  const { perModel, costUsd, unpriced } = costOf(s.models, overrides);
  const file = join(root, 'factory/jobs', id, 'usage', `${agentId}.json`);
  const before = readJson(file);
  writeJsonAtomic(file, {
    agentId,
    agent: agentType.replace(/^factory-/, ''),
    round: before?.round ?? roundOf(s.prompt, agentType),
    transcript: shortPath(path),
    models: perModel,
    tokens: Object.values(s.models).reduce((n, t) => n + tokensOf(t), 0),
    costUsd: unpriced.length ? null : costUsd,
    unpriced: unpriced.length ? unpriced : undefined,
    activeSeconds: s.activeSeconds,
    updatedAt: new Date().toISOString(),
  });
  return id;
}

/** Re-reads every recorded transcript for a job, picking up messages written late. */
export function refreshJob(root, id, overrides) {
  const dir = join(root, 'factory/jobs', id, 'usage');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const rec = readJson(join(dir, name));
    if (rec?.transcript) recordAgent(root, { agentId: rec.agentId, agentType: rec.agent, transcript: rec.transcript, job: id }, overrides);
  }
}

/** Rebuilds factory/usage.json from every job's usage files. */
export function rebuildSummary(root) {
  const jobsDir = join(root, 'factory/jobs');
  const jobs = {};
  for (const id of existsSync(jobsDir) ? readdirSync(jobsDir) : []) {
    const dir = join(jobsDir, id, 'usage');
    if (!existsSync(dir)) continue;
    const agents = readdirSync(dir).filter((n) => n.endsWith('.json'))
      .map((n) => readJson(join(dir, n))).filter(Boolean)
      .map(({ agentId, agent, round, models, tokens, costUsd, activeSeconds }) =>
        ({ agentId, agent, round, models: Object.keys(models || {}), tokens, costUsd, activeSeconds }));
    if (!agents.length) continue;
    jobs[id] = {
      costUsd: usd4(agents.reduce((n, a) => n + (a.costUsd || 0), 0)),
      unpriced: agents.some((a) => a.costUsd == null) || undefined,
      tokens: agents.reduce((n, a) => n + (a.tokens || 0), 0),
      activeSeconds: agents.reduce((n, a) => n + (a.activeSeconds || 0), 0),
      agents,
    };
  }
  writeJsonAtomic(join(root, 'factory/usage.json'), { version: 1, updatedAt: new Date().toISOString(), jobs });
}

// ---------- entry points ----------

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const [command, jobId] = process.argv.slice(2);
  const root = repoRoot();
  const overrides = readJson(join(root, 'factory/config.json'))?.pricing || {};

  if (command === 'refresh') {
    const ids = jobId ? [jobId] : readdirSync(join(root, 'factory/jobs'));
    for (const id of ids) refreshJob(root, id, overrides);
    rebuildSummary(root);
    return;
  }

  // Hook mode. Never fail loudly: a broken cost record mustn't disturb an agent.
  const input = JSON.parse(await readStdin() || '{}');
  if (!/^factory-/.test(input.agent_type || '') || !input.agent_transcript_path) return;
  await new Promise((r) => setTimeout(r, HOOK_FLUSH_MS));
  const id = recordAgent(root, {
    agentId: input.agent_id, agentType: input.agent_type, transcript: input.agent_transcript_path,
  }, overrides);
  if (!id) return;
  refreshJob(root, id, overrides);
  rebuildSummary(root);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    if (process.argv[2] === 'refresh') { console.error(`usage.mjs: ${err.message}`); process.exitCode = 1; }
  });
}
