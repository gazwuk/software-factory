# Project profile

## Stack
A Node.js CLI and Claude Code skill (`@gazwuk/software-factory`), plain ES modules
with no dependencies and no build step. Node 18 or later.

## Commands
- install: none (no dependencies)
- build: none
- test: `npm test` (`node --test test/*.test.js`)
- lint: none
- typecheck: none

## Layout
- `bin/cli.js`, `src/` — the installer CLI: `init`, `update`, `dashboard`, `run`.
- `template/` — what the CLI installs into a user's repo:
  - `template/.claude/skills/factory/SKILL.md` — the `/factory` orchestrator's instructions.
  - `template/.claude/skills/factory/*.mjs` — scripts the orchestrator and agents run
    (board, rounds, worktrees, usage, and from these changes on the runner and probe).
  - `template/.claude/agents/` — the factory's agent definitions.
  - `template/factory/` — config, board, backlog and the dashboard page.
- `test/` — `node --test` tests; they build throwaway git repos in the OS temp folder.

## Conventions
- Zero runtime dependencies; Node built-ins only.
- Every board and backlog write goes through a lock in `factory/.locks/`, because a
  Claude Code session and background processes can write at the same time.
- Scripts print one line of JSON for the orchestrator to act on.
- Comments are sparse and say why, not what.

## Interface
Has UI: the dashboard (`template/factory/dashboard.html`), a single static page that
polls the factory's JSON files. No UI probe for these jobs.
