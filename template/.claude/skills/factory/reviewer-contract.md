# Reviewer contract

Every factory reviewer follows these rules. The orchestrator gives you absolute paths
for everything below.

## Inputs

- `factory/project.md` — the repo's stack, commands and conventions.
- `spec.md` — what was asked for, including numbered acceptance criteria.
- `build.md` — what the builder says it did.
- The change itself: `git -C <worktree> diff <baseBranch>...factory/<id>`, plus any
  file in the worktree you need for context.
- Round 2 and later: your own review from the previous round folder, plus any
  `human.md` or `decision.md` there.

## Rules

- **Read-only.** Don't edit, commit, stash or check out anything in the worktree or
  the main checkout. You may run read-only commands and the project's test/lint
  commands inside the worktree.
- **Write exactly one file:** the output path you were given,
  `round-N/review-<name>.md`. Nothing else.
- **Stay in your lane.** Review only your focus area. Other reviewers cover the rest.
- **Review the change, not the codebase.** Pre-existing problems the change doesn't
  touch or worsen are out of scope.
- **CHANGES means blocking.** Use it only for problems that must be fixed before
  merge, each with a concrete required change. Everything else is a non-blocking
  suggestion and doesn't affect the verdict.
- **Later rounds converge.** Check whether each of your previous blocking findings
  was fixed. Raise new blocking findings only for code that changed since the last
  round or for serious problems you missed. Don't move the goalposts.

## Output format

The first line is the verdict, exactly one of:

```
VERDICT: PASS
VERDICT: CHANGES
```

Then:

```markdown
# <Reviewer name> review — <job id>, round N

## Summary
One or two sentences.

## Blocking
1. **<title>** — `path/to/file:line`
   Problem: …
   Required change: …
(or "None.")

## Previous findings        (round 2 and later)
- <finding> — fixed / not fixed

## Suggestions (non-blocking)
- …
```
