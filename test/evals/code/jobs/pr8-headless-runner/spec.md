# Headless runner

## Goal
Jobs run from request to merge without a Claude Code session: `run --parallel N` works
through active jobs and the backlog, and `run --job <id>`, `approve <id>` and
`rework <id> <note>` act on one job. A stopped or killed runner resumes from the job's
files, and a session and a runner can work in the same repo side by side.

## Context
- `template/.claude/skills/factory/SKILL.md` — the loop the runner reproduces in code,
  including its Resume rules.
- `template/.claude/skills/factory/round.mjs` — runs the checks and picks reviewers; the
  runner reuses it as a child process.
- `template/.claude/skills/factory/usage.mjs` — cost records.
- `src/run.js`, `bin/cli.js` — the CLI entry points.

## Scope
- `runner.mjs`: the loop as a Node process; `nextAction(job, facts)` works out the next
  step from the job's files.
- `board.mjs`: board updates, job id claims and backlog claims under file locks, used by
  both the runner and the session.
- `harness/claude-code.mjs`: runs one agent with `claude -p --agent factory-<name>`; the
  only Claude-specific file.
- `config.runner`: `headless`, `parallel`, `maxParallelChecks`, `permissionMode`.
- SKILL.md hands off to the runner when `runner.headless` is true or a runner is live.

## Out of scope
- Resolving merge conflicts. Pushing to a remote.

## Acceptance criteria
1. `run --parallel 2` takes two backlog items to merged, committing the usual job files
   and cost records.
2. A killed runner, run again, resumes each job from its files.
3. One process drives a job at a time; a second runner is refused.
4. Board updates, job id claims and backlog claims are made under a lock.
5. Ctrl+C stops the runner and the agents and checks it started.
6. `approve <id>` ships a needs-human job; `rework <id> <note>` sends it back to the
   builder with the note.
7. At most `runner.maxParallelChecks` jobs run checks at once.
8. `preflight()` refuses to start when `claude` is missing or lacks the needed flags.

## Assumptions
- A fresh builder runs for every step (no resumed sessions), as in the session loop.
