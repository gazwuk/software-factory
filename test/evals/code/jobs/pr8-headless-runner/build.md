# Build — pr8-headless-runner

## Summary
Added a headless runner (`runner.mjs`) that drives jobs through the factory loop with
`claude -p`, a locked board/backlog module (`board.mjs`) shared with the session, and
a Claude Code harness adapter.

## Changes
- `template/.claude/skills/factory/runner.mjs` — the loop, the scheduler, `ship()`,
  `approve`/`rework`, the checks limiter.
- `template/.claude/skills/factory/board.mjs` — `tryLock`/`withLock`/`withLockAsync`,
  `updateJob`, `claimJobId`, `claimBacklogItem`, and a CLI.
- `template/.claude/skills/factory/harness/claude-code.mjs` — `runAgent()` and `preflight()`.
- `template/.claude/skills/factory/SKILL.md` — writes the board through board.mjs; hands
  off to the runner.
- `template/.claude/skills/factory/usage.mjs` — `recordRun()` for runner agents.
- `src/run.js`, `bin/cli.js` — `software-factory run`.
- Tests: `test/board.test.js`, `test/runner.test.js` (with `test/fixtures/fake-claude.mjs`).

## Acceptance criteria
| AC | How it's met | Evidence (test name or check) |
|---|---|---|
| 1 | `runAll()` claims backlog items and drives them in parallel | runner.test.js "run --parallel 2 takes two backlog items to merged" |
| 2 | `nextAction()` reads the job's files | runner.test.js "kill and restart resumes from the files" |
| 3 | `drive()` holds a `job-<id>` lock; one scheduler lock | runner.test.js "a second runner is refused" |
| 4 | Every write under a lock, written atomically | board.test.js concurrent-process tests |
| 5 | Agents and checks run in their own process groups and are killed on abort | runner.test.js |
| 6 | `approve` → `ship()`; `rework` writes human.md and drives the job | runner.test.js "approve and rework" |
| 7 | `limiter(maxParallelChecks)` | manual |
| 8 | `preflight()` reads `claude --help` | runner.test.js "preflight rejects a missing or too-old claude" |

## Checks
`npm test`: 43 tests pass.
