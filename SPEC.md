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
- Appends to `.gitignore`: `factory/board.json`, `factory/usage.json`, `factory/.locks/`,
  `factory/activity/`, `.factory-worktrees/`, `factory/jobs/*/round-*/probe/` (probe screenshots).
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
    probe.mjs                        # UI probe: renders and measures screens [package]
    worktree.mjs                     # prepares new worktrees (links, setup) [package]
    usage.mjs                        # cost tracking (SubagentStop hook)  [package]
    board.mjs                        # locked board writes, job id claims [package]
    runner.mjs                       # headless runner                    [package]
    harness/claude-code.mjs          # starts agents with claude -p       [package]
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
  .locks/                            # lock folders (pid inside, renamed into place): board, ids, backlog, ship, runner, job-<id> [gitignored]
  activity/<id>.json                 # what the runner is running for a job now [gitignored]
  dashboard.html                                                         [package]
  .manifest.json                                                         [package]
  jobs/<job-id>/                     # one folder per job                [user]
    request.md                       # the task as given (typed, backlog item or issue)
    spec.md
    build.md
    round-1/round.md                 # checks, selected reviewers and why, diff commands
    round-1/round.json               # state for the next round's selection
    round-1/probe.md, probe.json     # UI probe report, when it ran
    round-1/probe/*.png              # probe screenshots                 [gitignored]
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
  "worktree": { "link": [".env.local"], "setup": "npm ci --prefer-offline" },
  "runner": {
    "headless": false,
    "harness": "claude-code",
    "parallel": 1,
    "maxParallelChecks": 1,
    "permissionMode": "dontAsk"
  },
  "ui": {
    "serve": "npm run dev -- --port {port}",
    "url": "http://localhost:{port}",
    "readyTimeout": 120,
    "viewports": [320, 768, 1280],
    "themes": ["light", "dark"],
    "storageState": null,
    "maxVisits": 60,
    "tabStops": 30
  },
  "models": {
    "spec-writer": "opus",
    "builder": "opus",
    "builder-fix": "sonnet",
    "approver": "opus"
  },
  "reviewers": {
    "security": { "model": "sonnet", "enabled": true,
                  "escalateModel": "opus", "escalatePaths": ["**/auth/**", "package.json"] },
    "ux":       { "model": "sonnet", "enabled": true, "probe": true, "paths": ["**/components/**", "**/pages/**"] },
    "ui":       { "model": "sonnet", "enabled": true, "probe": true, "paths": ["*.{css,scss,tsx}"] },
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
  review round. Written by `/factory setup`. A check can instead be a gate that sees
  only the change, `{ "command", "files", "scope" }` (see **Static UI gates**).
- `worktree`: how a new worktree is made runnable (see **Worktrees and git**).
  `link`: gitignored paths symlinked in from the main checkout; `setup`: a command
  run once in it. Written by `/factory setup`, which asks before linking anything.
- `reviewers.<key>.paths` (optional globs): the reviewer runs only when the change
  touches matching files. Absent = every change.
- `reviewers.<key>.escalatePaths` + `escalateModel` (optional): use `escalateModel`
  when the whole change touches matching files.
- `tasks.source`: where `/factory next` and `/factory backlog` read and write tasks —
  `"backlog"` (factory/backlog.md) or `"github"` (issues labelled `tasks.githubLabel`).
- `reviewers.<key>.probe` (optional): the UI probe runs before this reviewer, see
  **UI probe**. `ui` configures it; an empty `ui.serve` turns it off.
- `runner`: see **Runner**. `command` (optional) replaces the `claude` binary.

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
| `/factory setup` | Inspect the repo; write `project.md` (language, test/lint/typecheck commands, conventions, has-UI?); write `checks`; disable ux/ui if there's no UI, else tune their `paths` and security's `escalatePaths`; propose static UI gates (asks before installing). Re-runnable. |
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
| spec-writer | request.md, repo | `spec.md`: goal, scope, out of scope, screens and their states, numbered acceptance criteria (user flows as `(flow)` steps) |
| builder | spec.md, latest round folder (if any), rework note | code + tests in the worktree, commits on `factory/<job-id>`; `build.md`: what changed, how each acceptance criterion is met, test output |
| reviewer-* | spec.md, build.md, round.md (checks + its diff range), probe.md when the probe ran, worktree | `round-N/review-<name>.md`, first line `VERDICT: PASS` or `VERDICT: CHANGES`, then findings |
| approver | everything in the job folder, diff, final round.md (re-runs checks only if the branch moved) | `decision.md`, first line `APPROVE` or `ESCALATE`, then reasoning |

Every agent replies to the orchestrator with one line; the detail is in its file.

**Round preparation (`round.mjs`):** deterministic, no model. Per round it:

1. Refuses a dirty worktree, then runs `config.checks` in it on the branch head
   (gates on the change's files only, see **Static UI gates**). Failures go back to
   the builder (the stage stays `review`, no round is used up); after two failed
   fixes the job goes to needs-human.
2. For each of the job's reviewers, finds the commit it last passed at (`since`; the
   merge base if never), carried through rounds where it was skipped.
3. Selects it if its last verdict was CHANGES or missing, or if files matching its
   `paths` (all files when unset) changed between `since` and the head.
4. Picks `escalateModel` if the whole change touches its `escalatePaths`.
5. If a selected reviewer has `probe: true`, runs `probe.mjs` (see **UI probe**). New
   failures count as a failed check named `ui-probe`: the builder fixes them and no
   reviewer runs this round. (`prepareRound(..., { probeBlocks: false })`, used only
   by the reviewer benchmark, reports them to the reviewers instead.)
6. Writes `round.md` (results, selection table with reasons, a diff command from
   `<since>` to `<head>` per selected reviewer, diff stat, the probe's result) and
   `round.json`, and prints a one-line JSON summary. The diff commands are
   `round.mjs diff <worktree> <from> <to> [<path>...]`, which prints the diff with
   each line's number in its file in the margin, so reviewers cite real lines.

**Static UI gates:** checks in `config.checks` that lint only what the change
touches, so a rule can be switched on without fixing the whole repo first.

- **Shape:** `{ "command": "npx eslint -c factory/lint/eslint.config.mjs {files}",
  "files": ["*.{jsx,tsx}"], "scope": "lines" }`. `{files}` becomes the files changed
  since the merge base (deleted ones left out) that match `files` (all of them
  without it), shell-quoted. No matching files → the gate is skipped and passes.
- **`scope: "lines"`:** when the command fails, round.mjs reads the problem
  locations in its output: `path:line[:col]: …` lines (`unix` formatters), or a line
  holding a path followed by indented `line:col …` lines (eslint's `stylish`,
  stylelint's `string`). Only problems on lines the change added or changed (by
  `git diff -U0`; every line of a new file) fail it, and round.md shows only those.
  Older ones are counted in the result's note. Output with no locations at all fails
  as it is. Without `scope`, any failure fails.
- **Trying one:** `round.mjs check <name> <worktree> [<base>]` (and `tryCheck()`)
  runs one check as a round would, on the worktree including uncommitted and
  untracked work, against the merge base with `base` (baseBranch by default), and
  prints its result as JSON. Setup proves gates with it, and the builder runs gates
  with it before committing.
- **Which:** `/factory setup` proposes, and installs only if the user says yes,
  `ui-tokens` (`stylelint-declaration-strict-value` for the properties the repo has
  design tokens for) and `ui-a11y` (`eslint-plugin-jsx-a11y`,
  `eslint-plugin-vuejs-accessibility`, or `eslint-plugin-svelte`'s
  `svelte/valid-compile`), with their configs in `factory/lint/`. It proves each in
  the `setup-check` worktree: skipped with no matching change, fails on one new
  literal colour or `<div onClick>`, passes when that line uses the token, with older
  problems ignored. project.md's Interface records each gate and what it covers.
- **Limit:** a problem the change causes on a line it didn't touch (removing a
  `<label>` leaves its input unlabelled) isn't caught. The reviewers still read for
  those.

**UI probe (`probe.mjs`):** deterministic, no model; web UIs only. It turns the UI
and UX reviewers' checklists into measurements.

- **What it visits:** the rows of spec.md's `## Screens` table whose screen is a route.
  The `default` state is opened at the route; other states at the first backticked
  `/path` in "How to reach it". Rows it can't open are listed as not visited. Each is
  opened at every `ui.viewports` width (800px tall) in every `ui.themes` theme, capped
  at `ui.maxVisits`.
- **How:** starts `ui.serve` in the worktree on a free port (`{port}` and `PORT`),
  waits for `ui.url` to answer, and drives Chromium through the repo's own
  `playwright` and `axe-core` (none of the package's dependencies). Missing tools, no
  `ui.serve` or no screens → `skipped`, and reviewers work from the diff.
- **What it measures, per visit:** the page's HTTP status; uncaught page errors;
  console errors and failed requests; sideways overflow (`scrollWidth` beyond the
  viewport, with the outermost elements causing it); axe-core violations for WCAG 2.2
  A/AA (which include contrast and target size); cumulative layout shift; and a
  screenshot. Once per screen and state (widest viewport, first theme) it walks the
  Tab order, recording each stop's role, name and selector, whether its computed
  style changes on focus, and focus traps.
- **What blocks:** a page that fails to load or returns 4xx/5xx (unless the state is
  an error or not-found state), a page error, overflow, and serious or critical axe
  violations. Everything else is a warning for reviewers to judge.
- **Only new failures block.** When the head has blocking findings, the probe checks
  out the merge base beside the worktree, prepares it like a job worktree
  (`config.worktree`), serves it, and repeats those visits. A finding the base has
  too is `pre-existing`. With no `worktree.setup`, the base borrows the worktree's
  `node_modules` instead, so a change to dependency files (committed or not) can't be
  compared. If the
  base can't be prepared or won't start, the findings are `unverified`: reported, but
  not blocking. If the head won't start and the base does, that alone
  is a blocking failure; if neither starts, the startup failure is itself an
  unverified item, so a reviewer must answer it.
- **Output:** `probe.md` (failures, unverified, pre-existing, warnings, visits not
  made, a table of every visit with its screenshot, Tab orders), `probe.json` and
  `probe/*.png`. With no round argument (the builder checking its own work) it writes
  to a temp folder. probe.md and probe.json are committed with the job, so what they
  quote from the page and the server is redacted first (`redact()`): URL credentials,
  query strings and fragments, secret-looking query parameters, bearer tokens, JWTs,
  emails and long opaque path segments. Screenshots are gitignored and aren't.
- **IDs and lanes:** each item in probe.md has an ID: `F` blocking, `U` unverified, `P`
  pre-existing, `W` warning, `N` not visited, numbered in order. Each also has a lane
  that names the reviewer who answers for it. `ux` covers whether the page works and
  can be operated: load and status failures, page and console errors, failed
  requests, focus traps, unvisited states, and axe rules in the keyboard,
  name-role-value, forms and ARIA categories. `ui` covers everything else: overflow,
  layout shift, focus visibility and the other axe rules (contrast, text
  alternatives, structure, target size, …).
- **Checking a review:** `probe.mjs check-review <id> <n> <reviewer>` (and
  `checkReview()`) lists what a probe reviewer's review leaves out. It must answer
  every U, W and N item in the lanes it owns under `## Probe findings` (a range such
  as `W1–W6` answers each item in it), and list
  under `## Coverage` every screenshot it owes: all of them for the `ui` lane, and
  the Tab-order visits for `ux`. A reviewer owns its own lane, plus any lane whose
  reviewer isn't running this round. The runner counts a review with gaps as not
  written: it re-runs the reviewer once, telling it what's missing, and then the job
  goes to needs-human. The orchestrator does the same with the CLI.

**Builder lifecycle:** a fresh builder for every step — first build, each check fix,
each review round, each rework — never resumed with SendMessage. A resumed builder
carries the first build's whole context (often 150k+ tokens) into every turn of the
follow-up, which made follow-ups most of a job's cost. The files (spec.md with its
code map, build.md, the round folder, the branch) carry what a new builder needs.
Check and review fixes run on `models["builder-fix"]` (Sonnet by default); the first
build and human rework on `models.builder`.

**Reviewer contract:** the shared rules (inputs, read-only, blocking vs
non-blocking, converge in later rounds, cite evidence, probe evidence, output format)
live once in `reviewer-contract.md`. Each reviewer agent is just its focus checklist plus "read the
contract", so custom reviewers stay short and pick up contract fixes on `update`.

**UI and UX reviewers** each have four parts:
1. Probe evidence they must answer.
2. Rules with numbers (WCAG 2.2 AA thresholds, for example contrast 4.5:1 and 3:1,
   reflow at 320px, 24px targets, CLS ≤ 0.1), each with a way to check it from the
   diff when the probe didn't run.
3. Mechanical checks with grep commands (literal colours and sizes where tokens
   exist, removed outlines, positive tabindex, click handlers on non-interactive
   elements). They search only the lines the diff adds, with
   `round.mjs grep <worktree> <from> <to> '<regex>'`, which prints `file:line: text`
   using each line's number in its file (round.md gives the command). `grep -n` on
   diff output numbers lines of the diff, and reviewers cited those as file lines. They skip what a passing `ui-tokens` or `ui-a11y` gate already
   covers, as project.md's Interface records it.
4. Judgement, only where a screenshot or `file:line` can be cited.

UX also fills a Flows table: each `(flow)` criterion's test, whether it drives the UI,
covers every step and every `Expect:` line, and which check runs it.

**Custom reviewers:** any `factory-review-<name>.md` that follows the contract and is
listed in `config.reviewers`. At job start the orchestrator checks every enabled
reviewer has an agent file and fails fast if not. A reviewer added mid-session may not
be loaded by Claude Code until restart; the orchestrator then falls back to a
general-purpose agent given that file's body.

## Runner

`runner.mjs` is the loop in code, so jobs run with no Claude Code session. The CLI's
`run`, `approve` and `rework` import the copy installed in the repo, which therefore
always matches the repo's skill and agents.

- **Next step from files.** `nextAction(job, facts)` is a pure function of the board
  entry and the job's files (spec.md, worktree, commits ahead, build.md and its
  `## Round N response` sections, round.json, review verdicts, decision.md). It encodes
  SKILL.md's Resume rules. The runner applies it after every step, so a killed runner
  resumes from the files. The board keeps only what files can't show: check-fix
  attempts, in `job.runner.checkFixes`.
- **Agents** run through a harness module, `harness/<config.runner.harness>.mjs`. It
  exports `runAgent({ root, agent, model, prompt, tools, options, signal, onActivity })` →
  `{ ok, sessionId, error, reply, usage }` and optionally `preflight(options)`.
  `onActivity(text)` gets one line per tool call as it happens. `claude-code`
  runs `claude -p --agent factory-<name> --model <m> --output-format stream-json
  --verbose --permission-mode <mode> --allowedTools <the agent's tools:>` from the repo root,
  with the prompt on stdin. Prompts are the ones SKILL.md gives. A fresh agent for
  every step, never resumed. An agent that doesn't write its file runs once more, then
  the job goes to needs-human.
- **Checks** run as `node round.mjs` child processes with no timeout, at most
  `maxParallelChecks` at once. Agents and checks run in their own process groups, so
  stopping the runner stops them too.
- **Progress:** the runner logs each agent's tool calls, a `still working` line after
  60s with none, and `<agent> finished in <time>: <reply>`. While a job's agents or
  checks run, the process driving it rewrites `factory/activity/<id>.json` every 15s
  (`{ pid, updatedAt, steps: [{ name, model, startedAt, last, lastAt }] }`) and removes
  it when it stops driving the job. The dashboard shows the steps on the job's card
  and ignores a file more than 60s old (left by a runner that crashed).
- **Cost:** no SubagentStop hook fires for `claude -p` agents. The runner calls
  `usage.mjs` `recordRun`, which reads the session transcript when it's found, and
  otherwise the JSON result's `modelUsage`.
- **Scheduling:** `run` takes the `runner` lock (one scheduler per repo). It adopts
  active jobs, then claims tasks from `tasks.source`, keeping up to `--parallel` jobs
  going, and exits when none are left. Each job is driven under its own `job-<id>`
  lock, so `run --job`, `rework` and a scheduler never drive the same job twice.
- **Shared state:** board.json changes go through `board.mjs` `updateJob` (lock, read,
  merge one job, atomic rename), from the runner and from SKILL.md alike. Job ids are
  claimed under a lock with a non-recursive `mkdir`. Backlog items are ticked off, and
  added (`board.mjs backlog-add`), under a lock. A job is created before its item is
  ticked; one marked `pendingBacklogItem` took its item before a crash and gets the
  tick on the next claim.
- **Locks** are folders holding the holder's pid, renamed into place, so none is ever
  seen without its holder. A lock whose holder has exited is cleared only by the
  process that creates its `<lock>.reclaim-<pid>` marker, and only if it still names
  that pid. `board.mjs runner` lists live runner processes (the scheduler and each
  `job-<id>` holder), which SKILL.md checks before driving a job itself.
- **Recovery:** each job's agent and check process groups are listed in
  `job-<id>.agents`; a process that takes over a crashed runner's job stops them
  first. Before each step the current round's verdicts are copied from the files to
  the board. A ship checkpoints `runner.merged` before cleaning up, so a ship that
  stopped part-way carries on without merging again, and a failed record commit goes to
  needs-human for `approve` to retry. `approve` and `rework` hold the job's lock
  throughout.
- **Ship:** merges, worktree changes and record commits in the main checkout happen
  under the `ship` lock, one at a time across processes. A conflict still goes to
  needs-human.

## Worktrees and git

- Builder works in `.factory-worktrees/<job-id>` on branch `factory/<job-id>`, created
  by the orchestrator from baseBranch. The user's own checkout is never switched.
- A worktree holds only committed files. Right after creating one (new job, resume,
  rework), the orchestrator or runner runs `worktree.mjs <job-id>`: it symlinks each
  `config.worktree.link` path from the main checkout, runs `config.worktree.setup` in
  the worktree, and writes a `factory-ready` marker in the worktree's private git
  folder. The runner treats a worktree without the marker as missing, so a setup
  killed part-way runs again. A link that isn't gitignored in the worktree is refused,
  so secrets can't be committed from it; links are symlinks, so removing the worktree
  leaves the originals. Failure → needs-human, `worktree setup failed: <reason>`. The
  runner runs setup under the `maxParallelChecks` limit.
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

Written only through `board.mjs` (by the orchestrator and the runner), one job at a
time, under a lock. Shape:

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
bin/cli.js          # arg parsing → init | update | dashboard | run | approve | rework
src/                # init, update, dashboard server, manifest/hashing
template/           # exactly what lands in the user's repo
README.md
LICENSE             # MIT
test/               # node:test — init/update/dashboard, board locks, the runner (with a fake claude) against temp git repos
test/evals/         # opt-in reviewer benchmarks (npm run eval:reviewers, eval:code-reviewer); not in the package
```

## Reviewer benchmark

`npm run eval:reviewers` (`test/evals/run.mjs`) measures the UI and UX reviewers on
a fixture with planted defects. It runs real agents, so it isn't part of `npm test`.
`score.mjs` is pure and is.

- **Fixture (`test/evals/ui/`):** `base/` is main (a static app with design tokens,
  an orders API and Playwright tests), `change/` is what the job's branch adds or
  changes (an Orders page), `job/` holds request.md, spec.md (Screens with four
  routable states, flow criteria), build.md and project.md. `defects.json` lists 12
  planted defects (`lane`, `kind`, `locations` of `{ file, lines, text }`, plus an
  optional `probe` matcher, `state` and `keywords`) and the correct `controls`. A unit
  test checks each location's `text` is in its lines and that no two items overlap.
- **A run:** a temp repo with base committed on main, the factory installed from
  `template/` (src/init.js), config set for the variant (only ui and ux enabled, on
  the variant's model; `ui.serve` empty for probe off; light theme at 320 and 1280px),
  a worktree with the change committed, and the job folder. Round 1 is prepared by
  the temp repo's own `round.mjs` with `probeBlocks: false`, so the probe's failures
  are reported to the reviewers (round.md says so) instead of blocking. Then both
  reviewers run in parallel through the configured harness with the runner's
  reviewer prompt, and `checkReview` runs on each.
- **Scoring:** blocking findings are the numbered items under `## Blocking`. Each one's
  citations are its `file:line[-line]` references, probe IDs (plus any the review's
  Probe findings section answers with `blocking #<n>`) and screenshots. A finding
  finds a defect when a citation overlaps one of its locations, names a probe item
  matching its `probe` (kind, rule, target substring), or names a screenshot of a
  visit in its `state` while the finding's words contain one of its `keywords`.
  Recall is per lane (the reviewer's own), precision is matched findings ÷ blocking
  findings, and a false positive is a finding that matches no defect but cites a
  control.
- **Output:** per variant (`probe-on|off` × model), `--runs` runs (default 3), the
  mean and range of each metric, combined recall, probe recall, per-defect hit counts
  and cost from usage.mjs prices. Written to
  `test/evals/results/<date>-<variant>.json` with the review texts.

`npm run eval:code-reviewer` (`test/evals/code.mjs`) measures the code reviewer on
real defects from this repo's history. Both runners share `common.mjs` (round
preparation, running the reviewers, result files).

- **Cases (`test/evals/code/cases.json`):** a commit GitHub Copilot reviewed on one
  of this repo's PRs (`base` = the PR's merge base, `head` = the reviewed commit,
  `exclude` = pathspecs left out of the change, such as benchmark fixtures and
  results), and the problems Copilot raised there that were confirmed and fixed
  later, as `defects` with `{ file, lines, text }` locations in `head`. A defect raised
  in a later round of the PR is included when its code is already in `head`. A unit
  test checks each location against `git show <head>:<file>` (skipped in a shallow
  clone). `jobs/<case>/` holds request.md, spec.md and build.md, written from what the
  PR set out to do and nothing Copilot found; `project.md` is shared.
- **A run:** a temp repo with `git archive <base>` committed on main, the factory
  installed but not committed (so the worktree holds only the code under review;
  the installed factory is newer and has the fixes), only the code reviewer enabled
  on the variant's model, no checks, and a worktree with `git diff base head` applied
  and committed. Round 1 is prepared and reviewed as in the UI benchmark. Cases run in
  parallel.
- **Scoring:** `scoreReview` with lane `code`. A bare file name (`runner.mjs:406`)
  counts as a citation of that file. Unmatched = blocking findings that match no
  defect; with real code these aren't all false positives.
- **Output:** per model, `--runs` runs (default 3) of the `--cases` (default all):
  recall per case and over all cases, blocking and unmatched counts, per-defect hit
  counts and cost. Written to `test/evals/results/<date>-code-<model>.json` with the
  review texts.

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
