# software-factory

A small, visual software factory for [Claude Code](https://claude.com/claude-code).
One command adds a `/factory` skill, a team of subagents and a live dashboard to any
git repo. You give it a feature; it writes a spec, builds it on a branch, runs your
checks, puts it through the reviewers that matter for that change in parallel, and
either merges it or asks you. Afterwards a retro works out what made the job take
extra work, so you can fix the cause for the next one.

```
                   feature
                      ▼
                 spec-writer
                      ▼
                   builder ◄──────────────┐
                      ▼                   │
        checks · pick reviewers ──────────┤ checks fail
                      ▼                   │
   security · ux · ui · code  (parallel,  │ any CHANGES
     only those the change touches)       │ (max 2 rounds)
                      ▼                   │
                 WAIT FOR ALL ────────────┘
                      ▼ all PASS
                   approver
             APPROVE ▼      ▼ ESCALATE
         merge to main      needs you ◄── /factory approve
              ▼
            retro  ── why it took the path it did, and what to change
```

Everything is markdown and JSON in your repo, so you can read exactly what each agent
was told and what it said.

## Install

In the root of a git repo (with at least one commit):

```sh
npx github:gazwuk/software-factory init
```

Then open Claude Code in the repo and run:

```
/factory setup
```

Setup inspects the repo (language, test command, conventions) and writes
`factory/project.md`, which every agent reads. Commit the result:

```sh
git add .claude factory .gitignore && git commit -m "Add software factory"
```

To pin a release, add the tag: `npx github:gazwuk/software-factory#v0.1.0 init`.

**Requires** Claude Code, git and Node 18+. `gh` too if you use PR mode.

## Use

| In Claude Code | |
|---|---|
| `/factory <feature>` | Run a new feature through the loop now |
| `/factory backlog <feature>` | Shape a feature into a well-formed task and queue it |
| `/factory backlog` | List what's queued |
| `/factory next` | Run the next queued task (from the backlog or GitHub issues) |
| `/factory issue <number>` | Run a specific GitHub issue now |
| `/factory status` | Show the board in the terminal |
| `/factory resume` | Continue the active job (for example, after restarting Claude Code) |
| `/factory approve <job-id>` | Ship a job that's waiting for you |
| `/factory rework <job-id> <note>` | Send a job back to the builder with your feedback |
| `/factory add-reviewer <name> <focus>` | Add your own reviewer |
| `/factory retro` | Find causes that recur across recent jobs, and propose fixes for you to accept |
| `/factory retro <job-id>` | Run (or re-run) one finished job's retro |
| `/factory setup` | Re-inspect the repo |

Watch it work:

```sh
npx github:gazwuk/software-factory dashboard
```

Jobs move across the board as cards. Each review round shows as a row of reviewer
chips that fill in as verdicts land. Click a card to read its spec, build notes,
reviews, decision and cost. **Stats** shows how often each reviewer asks for changes
against what it costs, and where the money goes by role, model and job.

In a Claude Code session, one job runs at a time. Jobs waiting for you don't block
new ones. To run several at once, use the headless runner.

### Run it headless

```sh
npx github:gazwuk/software-factory run --parallel 2
```

The runner is a Node process that runs the same loop as `/factory` with no Claude Code
session open. It does the bookkeeping itself: the board, worktrees, checks, verdicts,
retries, merges and GitHub comments. It starts each agent with `claude -p`. That
leaves no orchestrator conversation to pay for or fill up, and checks run with no time
limit. The runner resumes any active jobs, then takes tasks from the backlog (or
GitHub) until none are left, keeping up to `--parallel` jobs going. Merges happen one
at a time.

| Command | |
|---|---|
| `run [--parallel N]` | Run active and queued jobs until none are left |
| `run --job <id>` | Run only this job |
| `approve <id>` | Ship a job that needs a human |
| `rework <id> <note>` | Send a job that needs a human back to the builder |
| `retro <id>` | Run (or re-run) a finished job's retro |

The runner prints each agent's tool calls as they happen (`[001-x] builder: Edit
src/app.js`). A step that goes a minute without one gets a `still working` line, and
each agent ends with `finished in 6m: <its reply>`. On the dashboard, a job's card
shows what's running for it and for how long.

To stop the runner, press Ctrl+C. Run it again and it carries on where each job got to.
Set `runner.headless` to `true` in config and `/factory next`, `/factory <feature>`,
`/factory issue`, `resume`, `approve` and `rework` hand their work to the runner in
the background, while the session stays free.

Each agent may use only the tools its definition lists (`tools:` in
`.claude/agents/factory-*.md`). Anything else is refused rather than prompted, because
nobody is there to answer.

## Giving it work

The spec-writer never stops to ask questions. Where a task is unclear, it guesses and
lists the guess under Assumptions in the spec. So the clearer the task, the better
the result:

- **One pull request's worth.** "Add CSV export to the invoices page", not "build
  reporting". Split big ideas into several tasks.
- **Describe the outcome, not the steps.** What can someone do or see when it's done?
- **Give the details that matter:** limits, formats, which page or endpoint, error
  behaviour.
- **Say what's out of scope** if there's an obvious next step you don't want yet.

The easiest way to get all of that is `/factory backlog <feature>`. It reads the code,
asks you up to three questions where the answer would change what gets built,
suggests a split if the task is too big, and then queues it.

### The backlog

`factory/backlog.md` is the default queue. An item is a `- [ ]` line plus any
indented lines under it:

```markdown
- [ ] Rate-limit the public API per API key
  Outcome: callers over 100 requests a minute get 429 with a Retry-After header.
  Details: limit by API key, not IP; the limit comes from the RATE_LIMIT env var.
  Out of scope: /admin routes.

- [ ] Add a /health endpoint that returns the build version and uptime
```

`/factory next` runs the first unchecked item and ticks it off.

### GitHub issues

To use labelled issues as the queue instead, set this in `factory/config.json`:

```json
"tasks": { "source": "github", "githubLabel": "factory" }
```

Then label an issue `factory` to queue it. `/factory next` takes the oldest open one,
labels it `factory-in-progress` and comments when it starts. It also comments if the
job needs you, and when it ships. In merge mode the merge commit says
`closes #<n>`, so the issue closes when you push. In PR mode the pull request
closes it. `/factory backlog <feature>` creates a labelled issue (after you confirm).
`/factory issue <n>` runs any issue straight away, labelled or not.

Needs `gh`, signed in to an account that can label and comment on the repo.

Only people with triage access can add labels, so applying the label is the approval
to build. Read an issue before you label it. The factory includes the issue body and
comments from owners, members and collaborators. Comments from anyone else are left
out.

## What gets installed

```
.claude/
  skills/factory/SKILL.md        the orchestrator: runs the loop, or hands it to the runner
  skills/factory/reviewer-contract.md
  skills/factory/round.mjs       runs the checks and picks the reviewers each round
  skills/factory/probe.mjs       the UI probe: renders the change's screens and measures them
  skills/factory/worktree.mjs    prepares new worktrees: links .env files, runs setup
  skills/factory/usage.mjs       records each agent's tokens and cost
  skills/factory/board.mjs       changes board.json under a lock; claims job ids
  skills/factory/retro.mjs       counts what a finished job's files show; tallies retros
  skills/factory/runner.mjs      the headless runner
  skills/factory/harness/        how the runner starts agents (claude-code.mjs)
  settings.json                  gains a SubagentStop hook that runs usage.mjs
  agents/factory-*.md            spec-writer, builder, approver, retro, and one per reviewer
factory/
  config.json                    your settings
  project.md                     repo profile (from /factory setup)
  backlog.md                     feature queue
  retros/                        reports from /factory retro
  board.json                     live state (gitignored)
  usage.json                     cost summary for the dashboard (gitignored)
  .locks/                        locks for the runner and board writes (gitignored)
  activity/                      what the headless runner is running now, for the dashboard (gitignored)
  dashboard.html
  jobs/<id>/                     request.md, spec.md, build.md, round-N/{round.md,probe.md,review-*.md}, decision.md, retro.json, retro.md, usage/
```

The builder works in a git worktree (`.factory-worktrees/<id>`, gitignored) on branch
`factory/<id>`, so your own checkout is never switched. When a job merges, its job
folder is committed as a record of what happened.

## Configure

`factory/config.json`:

```json
{
  "baseBranch": "main",
  "maxRounds": 2,
  "onApprove": "merge",
  "tasks": { "source": "backlog", "githubLabel": "factory" },
  "checks": { "test": "npm test", "lint": "npm run lint" },
  "worktree": { "link": [".env.local"], "setup": "npm ci --prefer-offline" },
  "runner": { "headless": false, "harness": "claude-code", "parallel": 1,
              "maxParallelChecks": 1, "permissionMode": "dontAsk" },
  "ui": { "serve": "npm run dev -- --port {port}", "url": "http://localhost:{port}",
          "viewports": [320, 768, 1280], "themes": ["light", "dark"] },
  "models": { "spec-writer": "opus", "builder": "opus", "builder-fix": "sonnet", "approver": "opus", "retro": "sonnet" },
  "retro": { "enabled": true },
  "reviewers": {
    "security": { "model": "sonnet", "enabled": true,
                  "escalateModel": "opus", "escalatePaths": ["**/auth/**", "package.json", "…"] },
    "ux": { "model": "sonnet", "enabled": true, "probe": true, "paths": ["**/components/**", "**/pages/**", "…"] },
    "ui": { "model": "sonnet", "enabled": true, "probe": true, "paths": ["*.{css,scss,tsx}", "…"] },
    "code": { "model": "sonnet", "enabled": true }
  }
}
```

- `maxRounds`: review rounds before a job is handed to you.
- `models.builder-fix`: the builder's model for fixing failed checks and review
  findings. The first build and `/factory rework` use `models.builder`.
- `retro.enabled`: run a [retro](#retros) after each job ships. `/factory retro <id>`
  works either way.
- `onApprove`: `"merge"` merges into `baseBranch` locally; `"pr"` pushes the branch
  and opens a pull request with `gh`.
- `tasks.source`: `"backlog"` (factory/backlog.md) or `"github"` (open issues
  labelled `tasks.githubLabel`). See [Giving it work](#giving-it-work).
- `checks`: commands run in the worktree after every build, before any reviewer.
  `/factory setup` fills them in. See [Checks and reviewer selection](#checks-and-reviewer-selection).
  A check can also be a gate that lints only the change; see [Static UI gates](#static-ui-gates).
- `worktree`: jobs run in a fresh git worktree holding only committed files, so
  anything gitignored the app or tests need is missing. `link` lists files to
  symlink in from your checkout (`.env` files; each must be gitignored), and `setup`
  is a command run once in each new worktree (install, codegen). `/factory setup`
  proposes both and asks before linking anything.
- `reviewers.<name>.paths`: run this reviewer only when the change touches files
  matching these globs. Leave it out to review every change.
- `reviewers.<name>.escalatePaths` / `escalateModel`: use `escalateModel` instead of
  `model` when the change touches these files.
- `reviewers.<name>.probe`: run the [UI probe](#ui-probe) before this reviewer.
- `ui`: how the UI probe serves and views the app. An empty `ui.serve` turns it off.
- Turn a reviewer off with `"enabled": false` rather than deleting it.
- `runner.headless`: hand `/factory` jobs to the headless runner.
  `runner.parallel` is the default for `--parallel`. `runner.maxParallelChecks` caps
  how many jobs run their checks at the same time (1 by default, so test suites don't
  fight over ports or databases).
- `runner.permissionMode`: passed to `claude --permission-mode`. The default,
  `dontAsk`, refuses tools an agent doesn't list. `runner.command` replaces the
  `claude` command, as a string or an argv array.
- `runner.harness`: which file in `skills/factory/harness/` starts agents. Only
  `claude-code` ships today. Another harness needs one file that exports `runAgent()`.

### Checks and reviewer selection

Each review round starts with `round.mjs`, a small script rather than an agent:

1. **Checks.** It runs every command in `checks` once, on the builder's last commit.
   If one fails, or the builder left uncommitted changes, the builder gets the output
   and tries again (twice at most) before any reviewer is spawned. Reviewers and the
   approver read the results instead of running the suite themselves.
2. **Who reviews.** A reviewer runs if the change touches its `paths`. In later rounds
   it runs again only if it asked for changes, or if files it covers changed since it
   passed; otherwise it shows as `SKIPPED` and its pass stands. Reviewers that run
   again are pointed at the diff since their last review.
3. **Which model.** If the change touches a reviewer's `escalatePaths`, it runs on
   `escalateModel`. So security is on Sonnet for most changes and Opus for
   authentication, dependencies, migrations and CI.
4. **UI probe.** If a selected reviewer has `probe: true` (ui and ux do), it runs
   `probe.mjs`; see below.

Everything it decided, and why, is in `round-N/round.md` (the **checks** tab on the
dashboard). Globs: `**` spans folders, `*` stays within one, `{a,b}` is either, and a
glob without `/` matches a file name anywhere (`package.json`, `*.css`). The default
`ux` and `ui` paths are generic front-end locations, and `/factory setup` adjusts them
to your repo.

### Static UI gates

Some UI rules don't need a model or a browser: a linter can catch a hard-coded colour
where a design token exists, or a `<div onClick>` with no role. For a repo with a UI,
`/factory setup` proposes two gates and adds them to `checks`, so they fail like any
other check and the builder fixes them before a reviewer looks:

- `ui-tokens`: [`stylelint-declaration-strict-value`](https://github.com/AndyOGo/stylelint-declaration-strict-value)
  for colours, font sizes, z-index and spacing, when the repo uses stylelint and has
  tokens.
- `ui-a11y`: `eslint-plugin-jsx-a11y` (React), `eslint-plugin-vuejs-accessibility`
  (Vue) or `eslint-plugin-svelte`'s compiler a11y warnings (Svelte): names, labels,
  alt text, interactive roles, positive `tabindex`.

It asks before installing anything, writes their config to `factory/lint/`, and
proves each gate in a throwaway worktree. If your lint config already has these
rules, it just makes sure `checks` runs it.

A gate only looks at the change, so turning a rule on doesn't mean fixing the
whole repo first:

```json
"ui-tokens": { "command": "npx stylelint --config factory/lint/stylelint.json --allow-empty-input {files}",
               "files": ["*.{css,scss}"], "scope": "lines" }
```

`{files}` becomes the changed files matching `files`. If none match, the gate is
skipped. With `scope: "lines"`, only problems on lines the change added or changed
fail it. Older problems in the same files are counted in round.md but don't block.
`node .claude/skills/factory/round.mjs check ui-tokens <worktree>` runs a gate by
hand, the way a round would. The UI and UX reviewers skip the grep checks a passing
gate already covers.

### Cost tracking

`init` adds a `SubagentStop` hook to `.claude/settings.json`. When a factory agent
finishes, the hook reads that agent's transcript and writes its tokens, estimated cost
and working time to `factory/jobs/<id>/usage/`. The record is committed with the job.
The headless runner's agents don't trigger the hook, so the runner records them itself
in the same files.

Costs are estimated at Anthropic API list prices, built into `usage.mjs` (and kept
current by `update`). On a Claude subscription you aren't billed per token, but the
numbers still show which agents, models and reviewers are worth what they use. To
override or add a price, put this in config (USD per million tokens):

```json
"pricing": { "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2 } }
```

### Retros

When a job ships, `retro.mjs` counts what its files show: review rounds, check fixes,
each reviewer's blocking findings, which ones the builder answered with "not
changed" and whether the reviewer then let them go, human reworks, escalations and
cost. That goes in `retro.json`. If any of it made the job less than a clean pass,
the `factory-retro` agent (Sonnet) reads the job's files and writes `retro.md`.
For each extra loop it names a cause, and it proposes lessons:

```markdown
## Causes
- `spec-gap` — Screens had no empty state for Orders; ux #2 asked for one (round-1/review-ux.md #2)
- `missing-check` — 2 check fixes for lint errors the builder didn't run (round-1/round.md)

## Lessons
- [project.md] Conventions: "Every list screen has an empty state that says what to do next."
- [config] checks.typecheck: "npx tsc --noEmit"
```

Causes come from a fixed list (`request-gap`, `spec-gap`, `build-miss`,
`missing-check`, `profile-gap`, `reviewer-noise`, `reviewer-miss`, `flaky-check`,
`environment`, `policy`), so they can be counted. A clean job gets no agent and no
extra cost. The retro runs after the merge, so it never holds up or changes a job.
It's committed with the job record. It's on the dashboard as the job's **Retro**
tab, and Stats shows how many of each reviewer's findings were disputed and dropped.

Nothing changes until you say so. `/factory retro` tallies recent retros, and for
each cause that turns up in two or more jobs it proposes one concrete edit: to
`factory/project.md`, `factory/config.json`, or a backlog task. You pick which to
apply. It writes a report to `factory/retros/<date>.md`, so it won't propose what
you declined again without new evidence. Lessons about the factory's own prompts are
listed for you rather than applied, because an edited factory file stops getting
`update`s.

### UI probe

For web UIs, the UI and UX reviewers start from measurements instead of a diff.
`probe.mjs` serves the job's worktree with `ui.serve`, opens every screen and state in
the spec's **Screens** table at each `ui.viewports` width in each `ui.themes` theme,
and records:

- axe-core violations against WCAG 2.2 A/AA (contrast, names, labels, target size, …)
- sideways overflow, and the elements causing it
- page errors, console errors, failed requests and the page's HTTP status
- layout shift (CLS)
- the Tab order, with each stop's name and whether focus is visible
- a screenshot of each visit, which the reviewers look at

Load failures, error statuses, page errors, overflow and serious or critical axe
violations block: the builder fixes them before any reviewer runs. They block only
if the change introduced them. The probe repeats failing visits on the merge base,
and anything already there is reported as pre-existing. The rest are warnings for
the reviewers. The report is `round-N/probe.md`; screenshots are in `round-N/probe/`
(gitignored). The report is committed with the job, so URLs and messages in it are
redacted: query strings, credentials, tokens and emails are masked.

Each item in the report has an ID and a lane, `ui` or `ux`, so every item has exactly
one owner. A UI or UX review must answer every item it owns and list the screenshots
it viewed. The factory checks that mechanically: a review with gaps is run again,
told what it missed, and then goes to you. The reviewers also check WCAG 2.2 AA
numbers (contrast, reflow at 320px, target size, focus) from the diff when there's
no probe, and the UX reviewer confirms each `(flow)` criterion has a test that drives
the UI.

It uses your repo's own `playwright` and `axe-core` (`npm i -D playwright axe-core`
and `npx playwright install chromium`); without them, or with no `ui.serve`, it's
skipped. `/factory setup` configures it. For screens behind a sign-in, point
`ui.storageState` at a Playwright storage-state file.

### Your own reviewers

```
/factory add-reviewer perf "N+1 queries, unbounded loops, missing indexes, payload size"
```

That creates `.claude/agents/factory-review-perf.md` and adds it to config (with
`paths` if the focus only covers part of the repo). Any
`factory-review-<name>.md` that follows `.claude/skills/factory/reviewer-contract.md`
works, so you can also write one by hand.

## Update

```sh
npx github:gazwuk/software-factory update
```

Replaces the factory's own files (skill, agents, dashboard) with the latest version
and adds any new settings to `config.json`. After an update that adds settings (such
as `checks` or reviewer `paths`), run `/factory setup` again to fill them in for your
repo. Your config values, backlog, jobs and
custom reviewers are never touched. If you've edited one of the factory's files, your
version is kept and the new one is saved beside it as `.new` for you to merge
(`--force` overwrites instead).

Before updating, let any job running in a Claude Code session finish or stop, and
start a new session afterwards so `/factory` loads the new skill.

**Retros:** `update` adds `retro.mjs`, the `factory-retro` agent, `models.retro` and
`retro.enabled` (on). Jobs that already shipped get no retro unless you run
`/factory retro <id>`.

**Upgrading to 0.3** (the headless runner): `update` adds `runner.mjs`, `board.mjs`
and `harness/`, adds a `runner` section to config (`headless: false`, so `/factory`
keeps working as before), and gitignores `factory/.locks/` and `factory/activity/`.
Jobs and the board are unchanged. If you'd edited `SKILL.md`, merge `SKILL.md.new` before using `run`: the
new skill writes the board through `board.mjs`, so a session and a runner can work
side by side. `run` needs a Claude Code recent enough for `claude -p --agent` with
`--permission-mode dontAsk`; it checks before it starts.

## Measuring the reviewers

When you change the UI or UX reviewer prompts, the reviewer contract or the probe,
the reviewer benchmark tells you whether reviews got better or worse. It's for working on the
factory itself, so it lives in this repo's `test/evals/` and isn't installed into
yours.

The fixture in `test/evals/ui/` is a small shop app. Its job branch adds an Orders page
with 12 planted defects, recorded in `defects.json` with their lane, file and lines:

- **UI:** a table that overflows at 320px, a literal `#333` where a colour token exists,
  `outline: none` with no replacement, text at 2.15:1 contrast, 16px tap targets.
- **UX:** an icon-only button with no name, a delete with no confirmation, a bare
  "Something went wrong.", a form that loses its input on a rejected submit, a dialog
  that doesn't return focus, a flow test that calls a function instead of pressing
  the button, and an empty state with no next step.

It also has correct changes nearby (token-only styles, labelled fields with tied
errors, a status region, a flow test that drives the UI), so false positives show up.

```
npm ci --prefix test/evals/ui/base                        # Playwright and axe-core for the probe
npx --prefix test/evals/ui/base playwright install chromium
npm run eval:reviewers                                    # 3 runs each, probe on and off
npm run eval:reviewers -- --runs 1 --probe on --models sonnet,opus
```

Each run builds a throwaway repo from the fixture, installs the factory from
`template/`, prepares round 1 with the real `round.mjs` and probe, and runs
`factory-review-ui` and `factory-review-ux` with `claude -p`. The probe's failures go
to the reviewers instead of blocking the round, so every defect reaches them.
`--keep` keeps each repo for a look at the reviews.

**Cost:** it runs real agents. A run is two reviews: about $0.40 on Sonnet at API
prices (measured with the probe on), and more on Opus. The default (3 runs × probe
on and off) is 12 reviews, about $2.50 on Sonnet.

**Scoring** is code, not a model (`test/evals/score.mjs`, tested in `npm test`). A
blocking finding finds a defect when it cites one of the defect's `file:line`
ranges, a probe ID whose finding matches it (`F2` is axe `button-name`), or a
screenshot of the defect's state together with one of its keywords. For each
variant it prints, per reviewer:

- **Recall:** the defects in its lane that it found.
- **Precision:** the blocking findings that found a defect, out of all of them.
- **False positives on controls:** blocking findings that hit a correct change and
  no defect.
- **check-review:** how many of its reviews answered every probe item and
  screenshot they owed.
- **Cost** per run, from the agents' token counts.

It also prints the recall of both reviewers together, the share of defects the probe's
items point at, and how often each defect was found. Model output varies, so each
number is the mean, with the range across runs in brackets. Results go to
`test/evals/results/<date>-probe-<on|off>-<model>.json`, reviews included. Commit
a run as the baseline, and compare the next one after a prompt change with the same
variant. The gap between `probe-on` and `probe-off` is what the probe adds.

## Tips

- Agents run many shell commands (tests, git). Allowing your test and git commands
  in Claude Code's permissions saves a lot of prompts.
- The agents are plain markdown. Read them, and tune them for your repo.

## License

MIT
