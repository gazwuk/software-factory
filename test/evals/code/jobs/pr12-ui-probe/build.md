# Build — pr12-ui-probe

## Summary
Added the UI probe, review checks, worktree preparation, static gates, a numbered
review diff and a reviewer benchmark, and rewrote the UI and UX reviewers.

## Changes
- `template/.claude/skills/factory/probe.mjs` — the probe and `check-review`.
- `template/.claude/skills/factory/round.mjs` — runs the probe, gates with `files` and
  `scope`, `diff` and `grep` commands, `addedLines`, `numberDiff`, `splitProblems`.
- `template/.claude/skills/factory/worktree.mjs` — links and setup.
- `template/.claude/skills/factory/runner.mjs` — re-runs a review with gaps once.
- Agents, the reviewer contract and SKILL.md — Screens tables, flows, probe evidence.
- `test/evals/` — the reviewer benchmark; `test/probe.test.js`, `test/worktree.test.js`,
  `test/round.test.js`.

## Acceptance criteria
| AC | How it's met | Evidence (test name or check) |
|---|---|---|
| 1 | `planVisits()`; rows with no URL go to `unreached` | probe.test.js |
| 2 | `compareWithBase()` on failing visits | manual run against a fixture repo |
| 3 | app-start finding when the base starts and the head doesn't | manual run with a broken branch |
| 4 | one screenshot per visit; `reviewGaps()` | probe.test.js |
| 5 | `baseCheckout()` refuses when dependency files changed and no setup is set | manual run with a package.json change |
| 6 | `tabWalk()` | probe.test.js |
| 7 | `splitProblems()` with `addedLines()` | round.test.js; real stylelint and ESLint gates |
| 8 | `numberDiff()` | round.test.js |
| 9 | `linkFiles()` checks `git check-ignore` | worktree.test.js |

## Checks
`npm test`: 94 tests pass.
