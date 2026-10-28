# software-factory

A small, visual software factory for [Claude Code](https://claude.com/claude-code).
One command adds a `/factory` skill, a team of subagents and a live dashboard to any
git repo. You give it a feature; it writes a spec, builds it on a branch, runs your
checks, puts it through the reviewers that matter for that change in parallel, and
either merges it or asks you.

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
| `/factory setup` | Re-inspect the repo |

Watch it work:

```sh
npx github:gazwuk/software-factory dashboard
```

Jobs move across the board as cards. Each review round shows as a row of reviewer
chips that fill in as verdicts land. Click a card to read its spec, build notes,
reviews, decision and cost. **Stats** shows how often each reviewer asks for changes
against what it costs, and where the money goes by role, model and job.

One job runs at a time. Jobs waiting for you don't block new ones.

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
  skills/factory/SKILL.md        the orchestrator: runs the loop, only writer of board.json
  skills/factory/reviewer-contract.md
  skills/factory/round.mjs       runs the checks and picks the reviewers each round
  skills/factory/usage.mjs       records each agent's tokens and cost
  settings.json                  gains a SubagentStop hook that runs usage.mjs
  agents/factory-*.md            spec-writer, builder, approver, and one per reviewer
factory/
  config.json                    your settings
  project.md                     repo profile (from /factory setup)
  backlog.md                     feature queue
  board.json                     live state (gitignored)
  usage.json                     cost summary for the dashboard (gitignored)
  dashboard.html
  jobs/<id>/                     request.md, spec.md, build.md, round-N/{round.md,review-*.md}, decision.md, usage/
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
  "models": { "spec-writer": "opus", "builder": "opus", "approver": "opus" },
  "reviewers": {
    "security": { "model": "sonnet", "enabled": true,
                  "escalateModel": "opus", "escalatePaths": ["**/auth/**", "package.json", "…"] },
    "ux": { "model": "sonnet", "enabled": true, "paths": ["**/components/**", "**/pages/**", "…"] },
    "ui": { "model": "sonnet", "enabled": true, "paths": ["*.{css,scss,tsx}", "…"] },
    "code": { "model": "sonnet", "enabled": true }
  }
}
```

- `maxRounds`: review rounds before a job is handed to you.
- `onApprove`: `"merge"` merges into `baseBranch` locally; `"pr"` pushes the branch
  and opens a pull request with `gh`.
- `tasks.source`: `"backlog"` (factory/backlog.md) or `"github"` (open issues
  labelled `tasks.githubLabel`). See [Giving it work](#giving-it-work).
- `checks`: commands run in the worktree after every build, before any reviewer.
  `/factory setup` fills them in. See [Checks and reviewer selection](#checks-and-reviewer-selection).
- `reviewers.<name>.paths`: run this reviewer only when the change touches files
  matching these globs. Leave it out to review every change.
- `reviewers.<name>.escalatePaths` / `escalateModel`: use `escalateModel` instead of
  `model` when the change touches these files.
- Turn a reviewer off with `"enabled": false` rather than deleting it.

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

Everything it decided, and why, is in `round-N/round.md` (the **checks** tab on the
dashboard). Globs: `**` spans folders, `*` stays within one, `{a,b}` is either, and a
glob without `/` matches a file name anywhere (`package.json`, `*.css`). The default
`ux` and `ui` paths are generic front-end locations, and `/factory setup` adjusts them
to your repo.

### Cost tracking

`init` adds a `SubagentStop` hook to `.claude/settings.json`. When a factory agent
finishes, the hook reads that agent's transcript and writes its tokens, estimated cost
and working time to `factory/jobs/<id>/usage/`. The record is committed with the job.

Costs are estimated at Anthropic API list prices, built into `usage.mjs` (and kept
current by `update`). On a Claude subscription you aren't billed per token, but the
numbers still show which agents, models and reviewers are worth what they use. To
override or add a price, put this in config (USD per million tokens):

```json
"pricing": { "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2 } }
```

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

## Tips

- Agents run many shell commands (tests, git). Allowing your test and git commands
  in Claude Code's permissions saves a lot of prompts.
- The agents are plain markdown. Read them, and tune them for your repo.

## License

MIT
