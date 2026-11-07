// Stands in for `claude -p --agent factory-<name>` in the runner tests: reads the
// prompt from stdin, writes the file that agent would write, and prints a JSON result.
//
// Env: FAKE_LOG=<file> appends one JSON line per run ({ agent, model, args }).
//      FAKE_BUILDER_HANG=<marker> makes the first builder run hang until killed.
//      FAKE_CHANGES_ONCE=<marker> makes the first code review ask for changes.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('  --agent <agent>\n  --allowedTools <tools...>\n  --output-format <format>\n  --permission-mode <mode> (choices: "default", "dontAsk")');
  process.exit(0);
}
const flag = (name) => args[args.indexOf(name) + 1];
const agent = flag('--agent').replace(/^factory-/, '');
const prompt = readFileSync(0, 'utf8');
const line = (label) => new RegExp(`^- ${label}[^:]*: (\\S+)`, 'm').exec(prompt)?.[1];
const once = (marker) => marker && !existsSync(marker) && (writeFileSync(marker, ''), true);

if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ agent, model: flag('--model'), args })}\n`);

if (agent === 'spec-writer') {
  writeFileSync(line('Output'), '# Spec\n\n## Goal\nDo the thing.\n\n## Acceptance criteria\n1. The thing is done.\n');
} else if (agent === 'builder') {
  if (once(process.env.FAKE_BUILDER_HANG)) await new Promise(() => setInterval(() => {}, 1000));
  const worktree = line('Worktree');
  const build = line('Build notes');
  const id = basename(worktree);
  const git = (...a) => execFileSync('git', ['-C', worktree, ...a], { stdio: 'pipe' });
  appendFileSync(join(worktree, `${id}.txt`), `${prompt.split('\n').pop()}\n`);
  git('add', '.');
  git('commit', '-qm', `factory(${id}): work`);
  const round = /## Round (\d+) response/.exec(prompt)?.[1];
  if (round) appendFileSync(build, `\n## Round ${round} response\n- fixed\n`);
  else if (!existsSync(build)) writeFileSync(build, `# Build — ${id}\n`);
} else if (agent.startsWith('review-')) {
  const changes = agent === 'review-code' && once(process.env.FAKE_CHANGES_ONCE);
  writeFileSync(line('Output'), changes ? 'VERDICT: CHANGES\n\n1. Fix it.\n' : 'VERDICT: PASS\n');
} else if (agent === 'approver') {
  writeFileSync(line('Output'), 'APPROVE\nReason: all criteria met\n');
}

console.log(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, session_id: randomUUID(), result: 'done', duration_ms: 2000,
  modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 50 } },
}));
