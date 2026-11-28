# Show headless runner progress

## Goal
While the headless runner works, the terminal and the dashboard show which step is
running for each job, what it last did and for how long.

## Context
- `template/.claude/skills/factory/runner.mjs` — `drive()` and `agentStep()`.
- `template/.claude/skills/factory/harness/claude-code.mjs` — `runAgent()`.
- `template/factory/dashboard.html` — polls `board.json` and renders job cards.

## Scope
- The harness streams `claude -p` events (`--output-format stream-json --verbose`) and
  reports each tool call through an `onActivity(text)` callback, plus the agent's reply.
- The runner prints a line per tool call, a "still working" line after 60s with no tool
  call, and a finish line with the duration and reply.
- The process driving a job writes `factory/activity/<id>.json` every 15s while a step
  runs and removes it when it stops driving the job. `factory/activity/` is gitignored.
- Active dashboard cards show each running step from that file.

## Acceptance criteria
1. Each tool call an agent makes prints as one line, with paths relative to the worktree
   or repo.
2. A step with no tool call for 60s prints `still working (<duration>; last: <call>)`.
3. Each agent ends with how long it took and its one-line reply.
4. While a step runs, `factory/activity/<id>.json` is rewritten every 15s; it is removed
   when the runner stops driving the job.
5. The dashboard shows the running steps on active cards, and shows nothing for an
   activity file more than 60s old, so a crashed runner leaves nothing showing.
6. `preflight()` also requires `stream-json` and `--verbose`.
