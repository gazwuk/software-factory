# Build — pr9-runner-progress

## Summary
The harness now streams events and reports tool calls; the runner prints progress and
writes per-job activity files that the dashboard renders.

## Changes
- `template/.claude/skills/factory/harness/claude-code.mjs` — stream-json parsing,
  `onActivity`, `reply`, `describe()`.
- `template/.claude/skills/factory/runner.mjs` — progress lines, heartbeat, activity files.
- `template/factory/dashboard.html` — activity polling and the running-step display.
- `src/util.js` — gitignores `factory/activity/`.
- Tests in `test/runner.test.js`; `test/fixtures/fake-claude.mjs` emits stream-json.

## Acceptance criteria
| AC | How it's met | Evidence (test name or check) |
|---|---|---|
| 1 | `describe()` and `ctx.log` | runner.test.js "prints each tool call" |
| 2 | heartbeat timer in `agentStep()` | runner.test.js |
| 3 | finish line in `agentStep()` | runner.test.js |
| 4 | `saveActivity()` every 15s; removed in `drive()`'s finally | runner.test.js "activity file during a run and its cleanup" |
| 5 | `pollActivity()` and `ACTIVITY_STALE_MS` | manual (not viewed in a browser) |
| 6 | `NEEDED` flags in the harness | runner.test.js |

## Checks
`npm test`: 54 tests pass.
