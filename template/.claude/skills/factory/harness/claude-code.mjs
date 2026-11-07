// Runs one factory agent headlessly with Claude Code: `claude -p --agent factory-<name>`.
//
// A harness module exports runAgent() and, optionally, preflight(). The runner calls
// nothing else, so supporting another harness means adding a file beside this one
// with the same exports and setting config.runner.harness to its name.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// The flags runAgent passes. Older Claude Code versions lack some of them.
const NEEDED = ['--agent', '--output-format', '--allowedTools', '--permission-mode'];

/** Returns why agents can't run (claude is missing, or too old for these flags), or null. */
export function preflight(options = {}) {
  const [command, ...pre] = [].concat(options.command || 'claude');
  const shown = [command, ...pre].join(' ');
  // Through a file: claude can exit before a pipe takes all of its --help.
  const dir = mkdtempSync(join(tmpdir(), 'factory-help-'));
  const fd = openSync(join(dir, 'help.txt'), 'w');
  let help;
  try {
    execFileSync(command, [...pre, '--help'], { stdio: ['ignore', fd, 'ignore'], timeout: 30_000 });
    help = readFileSync(join(dir, 'help.txt'), 'utf8');
  } catch (err) {
    return `\`${shown} --help\` failed (${err.code || `exit ${err.status}`}). Install Claude Code, or set config.runner.command.`;
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
  const missing = [...NEEDED, options.permissionMode || 'dontAsk'].filter((flag) => !new RegExp(`${flag}(?![\\w-])`).test(help));
  return missing.length ? `${shown} doesn't support ${missing.join(', ')}. Update Claude Code (\`claude update\`).` : null;
}

/**
 * Runs `agent` (e.g. "builder", for .claude/agents/factory-builder.md) on `model`
 * with `prompt`, from the repo root. `tools` are the tools the agent may use without
 * asking; `options` is config.runner (`command` overrides the claude binary, as a
 * string or an argv array). Aborting `signal` kills the agent.
 *
 * Resolves to { ok, sessionId, error, usage: { models, activeSeconds, transcript } },
 * where `models` has usage.mjs's per-model token shape.
 */
export async function runAgent({ root, agent, model, prompt, tools = [], options = {}, signal }) {
  const [command, ...pre] = [].concat(options.command || 'claude');
  const args = [
    ...pre, '-p', '--agent', `factory-${agent}`, '--model', model, '--output-format', 'json',
    '--permission-mode', options.permissionMode || 'dontAsk',
  ];
  if (tools.length) args.push('--allowedTools', tools.join(','));

  const { code, stdout, stderr, error } = await run(command, args, { cwd: root, input: prompt, signal });
  const result = parseResult(stdout);
  const sessionId = result?.session_id || null;
  const transcript = sessionId ? join(homedir(), '.claude/projects', root.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`) : null;
  const usage = {
    models: modelsOf(result?.modelUsage),
    activeSeconds: Math.round((result?.duration_ms || 0) / 1000),
    transcript: transcript && existsSync(transcript) ? transcript : null,
  };
  const ok = code === 0 && Boolean(result) && !result.is_error;
  const why = error?.message || result?.result || stderr.trim().split('\n').pop() || `exit ${code}`;
  return { ok, sessionId, error: ok ? null : `${agent}: ${String(why).slice(0, 200)}`, usage };
}

function parseResult(stdout) {
  const text = stdout.trim();
  for (const candidate of [text, text.slice(text.lastIndexOf('\n{') + 1)]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch { /* not this one */ }
  }
  return null;
}

// --output-format json reports usage per model. Older versions don't split cache
// writes by TTL; those are counted as 5-minute writes.
function modelsOf(modelUsage = {}) {
  const models = {};
  for (const [model, u] of Object.entries(modelUsage)) {
    const write1h = u.cacheCreationEphemeral1hInputTokens || 0;
    models[model] = {
      input: u.inputTokens || 0,
      output: u.outputTokens || 0,
      cacheRead: u.cacheReadInputTokens || 0,
      cacheWrite5m: (u.cacheCreationInputTokens || 0) - write1h,
      cacheWrite1h: write1h,
    };
  }
  return models;
}

// The agent runs in its own process group, so aborting also stops the commands it
// started (test runners, dev servers).
function run(command, args, { cwd, input, signal }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let error = null;
    const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { error = err; });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      resolvePromise({ code: code ?? 1, stdout, stderr, error });
    });
    child.stdin.on('error', () => {}); // the agent may exit before reading it all
    child.stdin.end(input);
  });
}
