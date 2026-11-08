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
const NEEDED = ['--agent', '--output-format', 'stream-json', '--verbose', '--allowedTools', '--permission-mode'];

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
 * string or an argv array). Aborting `signal` kills the agent. `onSpawn(pid)` gets the
 * agent's process group, so a runner that crashes can have it stopped later.
 * `onActivity(text)` gets a short line for each tool call as the agent makes it
 * ("Edit /abs/src/app.js", "$ npm test").
 *
 * Resolves to { ok, sessionId, error, reply, usage: { models, activeSeconds, transcript } },
 * where `reply` is the agent's final message and `models` has usage.mjs's per-model
 * token shape.
 */
export async function runAgent({ root, agent, model, prompt, tools = [], options = {}, signal, onSpawn, onActivity }) {
  const [command, ...pre] = [].concat(options.command || 'claude');
  const args = [
    ...pre, '-p', '--agent', `factory-${agent}`, '--model', model, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', options.permissionMode || 'dontAsk',
  ];
  if (tools.length) args.push('--allowedTools', tools.join(','));

  let result = null;
  const onEvent = (event) => {
    if (event.type === 'result') result = event;
    else if (event.type === 'assistant' && !event.parent_tool_use_id) {
      for (const block of event.message?.content || []) {
        if (block.type === 'tool_use') onActivity?.(describe(block.name, block.input || {}));
      }
    }
  };
  const { code, stderr, error } = await run(command, args, { cwd: root, input: prompt, signal, onSpawn, onEvent });
  const sessionId = result?.session_id || null;
  const transcript = sessionId ? join(homedir(), '.claude/projects', root.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`) : null;
  const usage = {
    models: modelsOf(result?.modelUsage),
    activeSeconds: Math.round((result?.duration_ms || 0) / 1000),
    transcript: transcript && existsSync(transcript) ? transcript : null,
  };
  const ok = code === 0 && Boolean(result) && !result.is_error;
  const why = error?.message || result?.result || stderr.trim().split('\n').pop() || `exit ${code}`;
  const reply = typeof result?.result === 'string' ? result.result.trim() : null;
  return { ok, sessionId, error: ok ? null : `${agent}: ${String(why).slice(0, 200)}`, reply, usage };
}

const oneLine = (text) => String(text ?? '').trim().split('\n', 1)[0];

/** A tool call as one line. The runner shortens it. */
export function describe(name, input) {
  if (name === 'Bash') return `$ ${oneLine(input.command)}`;
  const target = input.file_path || input.notebook_path || input.pattern || input.description || input.url;
  return target ? `${name} ${oneLine(target)}` : name;
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
// stream-json prints one JSON event per line; each goes to onEvent as it arrives.
function run(command, args, { cwd, input, signal, onSpawn, onEvent }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid) onSpawn?.(child.pid);
    let pending = '';
    let stderr = '';
    let error = null;
    const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted) kill(); // aborted already: the listener won't fire
    const take = (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; } // not an event
      if (event && typeof event === 'object') onEvent(event);
    };
    child.stdout.on('data', (d) => {
      const lines = (pending + d).split('\n');
      pending = lines.pop();
      lines.forEach(take);
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { error = err; });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      take(pending);
      resolvePromise({ code: code ?? 1, stderr, error });
    });
    child.stdin.on('error', () => {}); // the agent may exit before reading it all
    child.stdin.end(input);
  });
}
