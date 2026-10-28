import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  costOf, jobOf, priceFor, rebuildSummary, recordAgent, roundOf, summarizeTranscript,
} from '../template/.claude/skills/factory/usage.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-usage-'));
  temps.push(dir);
  return dir;
};

const PROMPT = 'Review round 1 of factory job 001-x.\n- Job folder: /repo/factory/jobs/001-x/\n- Output: /repo/factory/jobs/001-x/round-1/review-security.md';

function transcript() {
  const usage = (input, output, read, write, write1h = 0) => ({
    input_tokens: input, output_tokens: output, cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cache_creation: { ephemeral_5m_input_tokens: write - write1h, ephemeral_1h_input_tokens: write1h },
  });
  const lines = [
    { type: 'user', timestamp: '2026-10-28T10:00:00Z', message: { role: 'user', content: PROMPT } },
    // One response written as two lines (thinking + tool use): counted once.
    { type: 'assistant', timestamp: '2026-10-28T10:00:10Z', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: usage(10, 100, 1000, 2000) } },
    { type: 'assistant', timestamp: '2026-10-28T10:00:11Z', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: usage(10, 100, 1000, 2000) } },
    { type: 'user', timestamp: '2026-10-28T10:00:40Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', timestamp: '2026-10-28T10:01:00Z', message: { id: 'm2', model: 'claude-opus-5-5', usage: usage(5, 50, 0, 1000, 1000) } },
    // Resumed ten minutes later with a new instruction: the wait isn't working time.
    { type: 'user', timestamp: '2026-10-28T10:11:00Z', message: { role: 'user', content: 'Round 1 reviews are in…' } },
    { type: 'assistant', timestamp: '2026-10-28T10:11:30Z', message: { id: 'm3', model: '<synthetic>', usage: usage(0, 0, 0, 0) } },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"partial`;
}

test('summarizeTranscript counts each response once and excludes waiting time', () => {
  const s = summarizeTranscript(transcript());
  assert.deepEqual(s.models, {
    'claude-sonnet-5-5': { input: 10, output: 100, cacheRead: 1000, cacheWrite5m: 2000, cacheWrite1h: 0 },
    'claude-opus-5-5': { input: 5, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 1000 },
  });
  assert.equal(s.activeSeconds, 60 + 30);
  assert.equal(jobOf(s.prompt), '001-x');
  assert.equal(roundOf(s.prompt), 1);
});

test('prices match the longest model prefix, and cache writes are priced by TTL', () => {
  assert.equal(priceFor('claude-opus-5-5').input, 4);
  assert.equal(priceFor('claude-opus-5').input, 5);
  assert.equal(priceFor('claude-fable-5-1').output, 50);
  assert.equal(priceFor('gpt-x'), null);
  assert.equal(priceFor('claude-opus-5-5', { 'claude-opus-5-5': { input: 1, output: 1, cacheRead: 1 } }).input, 1);

  const { costUsd, perModel } = costOf(summarizeTranscript(transcript()).models);
  // sonnet: 10*2 + 100*10 + 1000*0.2 + 2000*2*1.25 = 6220 → $0.00622
  assert.equal(perModel['claude-sonnet-5-5'].costUsd, 0.0062);
  // opus: 5*4 + 50*20 + 1000*4*2 = 9020 → $0.00902
  assert.equal(perModel['claude-opus-5-5'].costUsd, 0.009);
  assert.equal(costUsd, 0.0152);

  const unknown = costOf({ 'mystery-1': { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
  assert.deepEqual(unknown.unpriced, ['mystery-1']);
});

test('recordAgent writes a per-agent file and rebuildSummary totals them per job', () => {
  const root = tempDir();
  mkdirSync(join(root, 'factory/jobs/001-x'), { recursive: true });
  const t = join(root, 'agent-a1.jsonl');
  writeFileSync(t, transcript());

  assert.equal(recordAgent(root, { agentId: 'a1', agentType: 'factory-review-security', transcript: t }), '001-x');
  assert.equal(recordAgent(root, { agentId: 'zz', agentType: 'factory-builder', transcript: join(root, 'missing.jsonl') }), null);

  const rec = JSON.parse(readFileSync(join(root, 'factory/jobs/001-x/usage/a1.json'), 'utf8'));
  assert.equal(rec.agent, 'review-security');
  assert.equal(rec.round, 1);
  assert.equal(rec.costUsd, 0.0152);
  assert.equal(rec.tokens, 10 + 100 + 1000 + 2000 + 5 + 50 + 1000);

  rebuildSummary(root);
  const summary = JSON.parse(readFileSync(join(root, 'factory/usage.json'), 'utf8'));
  assert.equal(summary.jobs['001-x'].costUsd, 0.0152);
  assert.equal(summary.jobs['001-x'].agents[0].agent, 'review-security');
  assert.deepEqual(summary.jobs['001-x'].agents[0].models, ['claude-sonnet-5-5', 'claude-opus-5-5']);
});

function installed() {
  const dir = tempDir();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

test('the hook records factory agents and ignores everything else', () => {
  const dir = installed();
  spawnSync(process.execPath, [CLI, 'init'], { cwd: dir });
  mkdirSync(join(dir, 'factory/jobs/001-x'), { recursive: true });
  const t = join(dir, 'agent-a1.jsonl');
  writeFileSync(t, transcript());
  const hook = (input) => spawnSync(process.execPath, [join(dir, '.claude/skills/factory/usage.mjs')], {
    cwd: dir, input: JSON.stringify(input), encoding: 'utf8',
  });

  const other = hook({ agent_id: 'b1', agent_type: 'Explore', agent_transcript_path: t });
  assert.equal(other.status, 0);
  assert.ok(!existsSync(join(dir, 'factory/jobs/001-x/usage')));

  const r = hook({ agent_id: 'a1', agent_type: 'factory-review-security', agent_transcript_path: t });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, 'factory/jobs/001-x/usage/a1.json')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'factory/usage.json'), 'utf8')).jobs['001-x'].costUsd, 0.0152);

  assert.equal(hook({ agent_type: 'factory-builder' }).status, 0, 'bad input never fails the hook');
});

test('init and update register the cost hook once, keeping existing settings', () => {
  const dir = installed();
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  const out = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.match(out, /SubagentStop hook/);

  const settings = () => JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings().permissions, { allow: ['Bash(npm test)'] });
  const [entry] = settings().hooks.SubagentStop;
  assert.equal(entry.matcher, '^factory-');
  assert.equal(entry.hooks[0].async, true);
  assert.match(entry.hooks[0].command, /factory\/usage\.mjs/);
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^factory\/usage\.json$/m);

  spawnSync(process.execPath, [CLI, 'update'], { cwd: dir });
  assert.equal(settings().hooks.SubagentStop.length, 1, 'not added twice');

  writeFileSync(join(dir, '.claude/settings.json'), '{ not json');
  const r = spawnSync(process.execPath, [CLI, 'update'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /isn't valid JSON/);
});
