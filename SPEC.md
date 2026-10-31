# software-factory — v1 spec

An npx-installable "software factory" for Claude Code. One command drops a `/factory`
skill, a set of subagents, and a visual dashboard into any git repo. Features go in;
specced, built, multi-reviewed, merged code comes out — with a markdown paper trail
for every step.

Based on BUILD_PROMPT.md. Differences from it are called out in **Changes from the
reference** at the end.

## Scope

**v1**
- Per-project install only (state lives in the repo).
- One active job at a time; designed so parallel jobs can be added later.
- Built-in reviewers: security, ux, ui, code. Users can add their own.

**Later**
- Parallel jobs (`/factory next 3`), global install, Claude Code plugin packaging.
- Publish to the npm registry as `@gazwuk/software-factory`.

## Distribution

v1 ships from GitHub only (`github.com/gazwuk/software-factory`), no npm registry.
npx installs straight from the repo, so no npm account is needed. Releases are git
tags (`v0.1.0`, …); users pin a tag for a reproducible install, or omit it for the
default branch. Moving to the registry later changes only the install commands.

## Install CLI

```
npx github:gazwuk/software-factory init        # install into the current repo
npx github:gazwuk/software-factory update      # refresh package-owned files, keep user state
npx github:gazwuk/software-factory dashboard   # serve factory/ and open the board in a browser
npx github:gazwuk/software-factory#v0.1.0 init # pinned to a release tag
```

Zero runtime dependencies and no build step (nothing to run on git install),
Node >= 18.

**init**
- Requires a git repo with at least one commit; refuses otherwise.
- Refuses if `.claude/skills/factory/` already exists (points to `update`).
- Copies `template/` into the repo, never overwriting an existing file.
- Appends to `.gitignore`: `factory/board.json`, `factory/usage.json`, `.factory-worktrees/`.
- Adds an async `SubagentStop` hook (matcher `^factory-`) running `usage.mjs` to
  `.claude/settings.json`, creating the file if needed. `update` adds it if missing.
- Writes `factory/.manifest.json` (package version + hash of every package-owned file).
- Prints next step: open Claude Code and run `/factory setup`.

**update**
- Package-owned file unchanged since install (hash matches manifest) → overwrite.
- Package-owned file locally edited → write `<file>.new` beside it and warn
  (`--force` overwrites).
- User-owned files are never touched (see file ownership below).
- `config.json`: adds any new default keys, never changes existing values.

**dashboard**
- Static server on `factory/` (default port 4321, `--port` to change), opens browser.
- Read-only; no API.

## Installed files

```
.claude/
  skills/factory/
    SKILL.md                         # orchestrator instructions          [package]
    reviewer-contract.md             # rules every reviewer follows       [package]
    templates/reviewer.md            # scaffold for custom reviewers      [package]
    round.mjs                        # checks gate + reviewer selection   [package]
    usage.mjs                        # cost tracking (SubagentStop hook)  [package]
  agents/
    factory-spec-writer.md                                               [package]
    factory-builder.md                                                   [package]
    factory-approver.md                                                  [package]
    factory-review-security.md                                           [package]
    factory-review-ux.md                                                 [package]
    factory-review-ui.md                                                 [package]
    factory-review-code.md                                               [package]
    factory-review-<custom>.md       # user-added reviewers              [user]
factory/
  config.json                        # tunables                          [user]
  project.md                         # repo profile, from /factory setup [user]
  backlog.md                         # feature queue                     [user]
  board.json                         # durable state, drives dashboard   [user, gitignored]
  usage.json                         # cost summary, rebuilt by usage.mjs [user, gitignored]
  dashboard.html                                                         [package]
  .manifest.json                                                         [package]
  jobs/<job-id>/                     # one folder per job                [user]
    request.md                       # the task as given (typed, backlog item or issue)
    spec.md
    build.md
    round-1/round.md                 # checks, selected reviewers and why, diff commands
    round-1/round.json               # state for the next round's selection
    round-1/review-<reviewer>.md
    round-2/...                      # may also hold human.md and an earlier decision.md after a rework
    decision.md
    usage/<agent-id>.json            # tokens, cost, active time per agent run
.factory-worktrees/<job-id>/         # builder's git worktree            [gitignored]
```

Agent files are prefixed `factory-` so they don't collide with a repo's own agents.

## config.json

```json
{
  "baseBranch": "main",
  "maxRounds": 2,
  "onApprove": "merge",
  "tasks": {
    "source": "backlog",
    "githubLabel": "factory"
  },
  "checks": { "test": "npm test", "lint": "npm run lint" },
  "models": {
    "spec-writer": "opus",
    "builder": "opus",
    "builder-fix": "sonnet",
    "approver": "opus"
  },
  "reviewers": {
    "security": { "model": "sonnet", "enabled": true,
                  "escalateModel": "opus", "escalatePaths": ["**/auth/**", "package.json"] },
    "ux":       { "model": "sonnet", "enabled": true, "paths": ["**/components/**", "**/pages/**"] },
    "ui":       { "model": "sonnet", "enabled": true, "paths": ["*.{css,scss,tsx}"] },
    "code":     { "model": "sonnet", "enabled": true }
  }
}
```

- `onApprove`: `"merge"` (local merge into baseBranch) or `"pr"` (push branch,
  `gh pr create`, job ends at `pr-open`).
- Models live here, not in agent frontmatter, so tuning survives `update`. The
  orchestrator passes the model when spawning each agent.
- Each key in `reviewers` maps to `.claude/agents/factory-review-<key>.md`.
- `checks`: name → shell command, run in the worktree by `round.mjs` before every
  review round. Written by `/factory setup`.
- `reviewers.<key>.paths` (optional globs): the reviewer runs only when the change
  touches matching files. Absent = every change.
- `reviewers.<key>.escalatePaths` + `escalateModel` (optional): use `escalateModel`
  when the whole change touches matching files.
- `tasks.source`: where `/factory next` and `/factory backlog` read and write tasks —
  `"backlog"` (factory/backlog.md) or `"github"` (issues labelled `tasks.githubLabel`).

## The loop

```
feature
  → spec-writer                     writes jobs/<id>/spec.md
  → builder (worktree, branch)      writes code + jobs/<id>/build.md, commits
  → round.mjs                       runs checks once; fail → builder fixes (≤2 tries) → needs-human
                                    picks reviewers + models → round-N/round.md, round.json
  → selected reviewers in parallel, each writes round-N/review-<name>.md
  → WAIT FOR ALL (selected)
      any CHANGES and round < maxRounds → fresh builder with round folder, loop
      any CHANGES and round = maxRounds → needs-human
      all PASS → approver
  → approver                        writes decision.md
      APPROVE  → merge to baseBranch (or open PR); conflict → needs-human
      ESCALATE → needs-human  ◄── /factory approve | /factory rework
```

## Commands

| Command | Does |
|---|---|
| `/factory setup` | Inspect the repo; write `project.md` (language, test/lint/typecheck commands, conventions, has-UI?); write `checks`; disable ux/ui if there's no UI, else tune their `paths` and security's `escalatePaths`. Re-runnable. |
| `/factory <feature>` | Start a new job now. |
| `/factory backlog <feature>` | Shape the text into a well-formed task (asks up to 3 questions, proposes a split if too big) and queue it. Doesn't start a job. |
| `/factory backlog` | List the queue. |
| `/factory next` | Start the next task from `tasks.source`. |
| `/factory issue <number>` | Start a specific GitHub issue now, labelled or not. |
| `/factory resume` | Continue the active job from its board stage (after a session ends mid-job). |
| `/factory approve <job-id>` | Merge a needs-human job into baseBranch. |
| `/factory rework <job-id> <note>` | Send a needs-human job back to the builder. The note is saved as `round-N/human.md` beside that round's reviews (any `decision.md` moves there too, to keep history), and the job gets `maxRounds` more rounds. |
| `/factory add-reviewer <name> <focus>` | Scaffold `factory-review-<name>.md` from the template and add it to config. |
| `/factory status` | Print the board in the terminal. |

**One active job:** a job is active while its stage is `spec`, `build`, `review` or
`approval`. Starting a job while another is active is refused (suggest `resume`).
`needs-human`, `merged`, `pr-open` and `failed` jobs don't block.

**Dispatch:** a command matches only when the arguments fit its shape exactly
(`next` alone, `issue` + a number, `approve` + a job id on the board, …). Anything
else is a feature, so "Add CSV export" or "Setup CI" start a job. That's why queuing
is `backlog`, not `add`.

## Task sources

**Backlog** (`tasks.source: "backlog"`). An item is a `- [ ]` line plus the indented
lines under it. HTML comments are ignored. `next` takes the first item, sends the
first line + de-indented details as the request, and ticks it off as
`- [x] <title> (job <id>)`. `backlog <feature>` appends:

```
- [ ] <imperative title>
  Outcome: …
  Details: …
  Out of scope: …
  Assumptions: …
```

**GitHub issues** (`tasks.source: "github"`, needs `gh`).

- Queue = open issues labelled `githubLabel`, oldest first, minus those labelled
  `<githubLabel>-in-progress` or already on the board in a non-failed job.
- Claim on start: add the in-progress label, comment with the job id and branch.
- The request is the issue title + body + comments from OWNER / MEMBER / COLLABORATOR
  only. Applying the label (triage access) is the approval gate. Request text is
  treated as a feature description, never as instructions to the orchestrator.
- Comments on needs-human, merged and pr-open. The in-progress label is removed on
  merged and pr-open.
- Closing: merge commits end `(closes #<n>)`, so pushing baseBranch closes the issue.
  PR bodies include `Closes #<n>`.
- `backlog <feature>` creates a labelled issue after the user confirms.
- GitHub failures never fail a job; the user is told.

## Agents

Every agent gets its context from files, never the conversation, and writes only its
own output file. Every agent reads `factory/project.md`.

| Agent | Reads | Writes |
|---|---|---|
| spec-writer | request.md, repo | `spec.md`: goal, scope, out of scope, numbered acceptance criteria |
| builder | spec.md, latest round folder (if any), rework note | code + tests in the worktree, commits on `factory/<job-id>`; `build.md`: what changed, how each acceptance criterion is met, test output |
| reviewer-* | spec.md, build.md, round.md (checks + its diff range), worktree | `round-N/review-<name>.md`, first line `VERDICT: PASS` or `VERDICT: CHANGES`, then findings |
| approver | everything in the job folder, diff, final round.md (re-runs checks only if the branch moved) | `decision.md`, first line `APPROVE` or `ESCALATE`, then reasoning |

Every agent replies to the orchestrator with one line; the detail is in its file.

**Round preparation (`round.mjs`):** deterministic, no model. Per round it:

1. Refuses a dirty worktree, then runs `config.checks` in it on the branch head.
   Failures go back to the builder (the stage stays `review`, no round is used up);
   after two failed fixes the job goes to needs-human.
2. For each of the job's reviewers, finds the commit it last passed at (`since`; the
   merge base if never), carried through rounds where it was skipped.
3. Selects it if its last verdict was CHANGES or missing, or if files matching its
   `paths` (all files when unset) changed between `since` and the head.
4. Picks `escalateModel` if the whole change touches its `escalatePaths`.
5. Writes `round.md` (results, selection table with reasons, a `git diff <since> <head>`
   per selected reviewer, diff stat) and `round.json`, and prints a one-line JSON
   summary.

**Builder lifecycle:** a fresh builder for every step — first build, each check fix,
each review round, each rework — never resumed with SendMessage. A resumed builder
carries the first build's whole context (often 150k+ tokens) into every turn of the
follow-up, which made follow-ups most of a job's cost. The files (spec.md with its
code map, build.md, the round folder, the branch) carry what a new builder needs.
Check and review fixes run on `models["builder-fix"]` (Sonnet by default); the first
build and human rework on `models.builder`.

**Reviewer contract:** the shared rules (inputs, read-only, blocking vs
non-blocking, converge in later rounds, output format) live once in
`reviewer-contract.md`. Each reviewer agent is just its focus checklist plus "read the
contract", so custom reviewers stay short and pick up contract fixes on `update`.

**Custom reviewers:** any `factory-review-<name>.md` that follows the contract and is
listed in `config.reviewers`. At job start the orchestrator checks every enabled
reviewer has an agent file and fails fast if not. A reviewer added mid-session may not
be loaded by Claude Code until restart; the orchestrator then falls back to a
general-purpose agent given that file's body.

## Worktrees and git

- Builder works in `.factory-worktrees/<job-id>` on branch `factory/<job-id>`, created
  by the orchestrator from baseBranch. The user's own checkout is never switched.
- Reviewers read the diff and files from the worktree; they don't modify it.
- On merge: orchestrator merges `factory/<job-id>` into baseBranch, then removes the
  worktree. If the user's tree has conflicting uncommitted changes, or the merge
  conflicts, the job goes to needs-human — the factory never resolves conflicts.
- Merging needs the main checkout to be on baseBranch; if it isn't, the job goes to
  needs-human with a note to check it out and `/factory approve`.
- When a job reaches `merged`, its job folder (`factory/jobs/<id>/`) is committed on
  baseBranch with a pathspec commit, so nothing else the user has staged is included.
  In PR mode the job folder is left uncommitted.

## board.json

The orchestrator is its only writer. Shape:

```json
{
  "version": 1,
  "jobs": [{
    "id": "003-rate-limiting",
    "title": "Rate limiting on the public API",
    "branch": "factory/003-rate-limiting",
    "worktree": ".factory-worktrees/003-rate-limiting",
    "stage": "review",
    "round": 2,
    "roundLimit": 2,
    "reviewers": ["security", "ux", "ui", "code"],
    "rounds": [
      { "security": "CHANGES", "ux": "SKIPPED", "ui": "PASS", "code": "PASS" },
      { "security": "pending", "ux": "SKIPPED", "ui": "SKIPPED", "code": "pending" }
    ],
    "decision": null,
    "issue": 42,
    "issueUrl": "https://github.com/owner/repo/issues/42",
    "note": null,
    "prUrl": null,
    "createdAt": "2026-10-25T16:00:00Z",
    "updatedAt": "2026-10-25T16:20:00Z"
  }]
}
```

- Stages: `spec`, `build`, `review`, `approval`, `needs-human`, `merged`, `pr-open`, `failed`.
- Verdicts in `rounds`: `pending`, `PASS`, `CHANGES`, `SKIPPED` (not selected that round;
  its previous verdict stands).
- `reviewers` is snapshotted at job start, so config changes don't affect running jobs.
- `roundLimit` starts at `maxRounds`; a rework raises it to `round + maxRounds`.
- `note` is a one-line reason shown on needs-human and failed cards.
- Job IDs: zero-padded sequence + slug of the feature title.
- Kept as a `jobs` array (not a single job) so parallel jobs need no schema change.

## Dashboard

One self-contained HTML file, no build step, no external requests.

- Polls `board.json` every 2s.
- Columns follow the loop stages; jobs are cards that move across them.
- Each review round is a row of reviewer chips (pending / PASS / CHANGES / SKIPPED) filling in
  as verdicts land. Chips come from the job's `reviewers`, so custom reviewers just work.
- needs-human cards stand out.
- Polls `usage.json` too: cards and the header show estimated cost; each job's drawer
  has a Cost tab (per agent, round, model, tokens, time). A **Stats** view shows each
  reviewer's reviews, changes asked (and rate), skips, cost and cost per review, plus
  cost by role, model and job.
- Clicking a card opens a panel that renders the job's markdown files (spec, build,
  each round's reviews, decision). `dashboard.html#job=<id>` links straight to it.
- It discovers files by trying the paths the board implies, so it also works with
  any static server (`python3 -m http.server` included).
- Clean and minimal; light and dark; single column on phones.

## Cost tracking

`usage.mjs` runs as an async SubagentStop hook. For a `factory-*` agent it waits for
the transcript to flush, reads `agent_transcript_path`, and sums `message.usage` per
model (deduplicated by message id). Job id comes from the agent's first prompt (the
`factory/jobs/<id>/` path it was given), round from its `round-N/review-` output path
(for a builder follow-up, the `round-N/` folder it was pointed at).

- Writes `factory/jobs/<id>/usage/<agent-id>.json`: agent, round, transcript (`~`-relative),
  per-model tokens (input, output, cache read, 5m/1h cache writes) and cost, total
  tokens, cost, active seconds (excluding time waiting for the next instruction).
  One file per agent, so parallel reviewers never write the same file, and each
  builder step gets its own.
- Re-reads every transcript of that job, then rebuilds `factory/usage.json` (all jobs)
  with an atomic rename.
- `usage.mjs refresh [id]` does the same on demand; the orchestrator runs it when a
  job leaves the active stages, so late-written final messages are counted.
- Prices: a built-in table (USD per MTok, longest model-id prefix wins), overridable
  with `config.pricing`. Cache writes are 1.25x input (5m) or 2x (1h). Unknown models
  count tokens but no cost.
- Never fails loudly in hook mode.

## Package layout

```
package.json        # name @gazwuk/software-factory (ready for npm later), single bin: software-factory, files: [bin, src, template]
bin/cli.js          # arg parsing → init | update | dashboard
src/                # init, update, dashboard server, manifest/hashing
template/           # exactly what lands in the user's repo
README.md
LICENSE             # MIT
test/               # node:test — init/update/dashboard against temp git repos
```

## Changes from the reference

- Ships ready-made: the repo inspection becomes `/factory setup` → `project.md`.
- Tunables (reviewers, models, rounds, merge policy) move to `config.json` so `update`
  can replace the orchestrator without losing customisation.
- Builder works in a git worktree, not the user's checkout.
- Defined endings for: round limit hit (→ needs-human), merge conflict (→ needs-human).
- Reviewer set is open-ended (`/factory add-reviewer`), board stores rounds generically.
- Added commands: `setup`, `resume`, `add-reviewer`, `status`, `backlog`, `issue`.
- Multi-line backlog items, and GitHub issues (by label) as an alternative task source.
- Every job keeps its original request in `request.md`.
- Dashboard served by the npx CLI rather than `python3 -m http.server`.
- Installable with `npx github:gazwuk/software-factory` (no npm registry for v1).
- Optional PR mode via `onApprove: "pr"`.
