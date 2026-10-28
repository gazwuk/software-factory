# Reviewer contract

Every factory reviewer follows these rules. The orchestrator gives you absolute paths
for everything below.

## Inputs

- `factory/project.md` — the repo's stack, commands and conventions.
- `spec.md` — what was asked for, including numbered acceptance criteria.
- `build.md` — what the builder says it did.
- `round-N/round.md` — the commit under review, the results of the project's checks
  on that commit, the changed files, and the exact `git diff` command for your review.
- Any file in the worktree you need for context.
- If round.md lists a last review for you: that review, plus any `human.md` or
  `decision.md` in the round folders since.

## Rules

- **Read-only.** Don't edit, commit, stash or check out anything in the worktree or
  the main checkout. You may run read-only commands inside the worktree.
- **Don't re-run the checks.** round.md has the test, lint and type-check results for
  this exact commit, and a round only reaches you once they pass. Run a single
  targeted test only when you need it to confirm a specific finding.
- **Write exactly one file:** the output path you were given,
  `round-N/review-<name>.md`. Nothing else.
- **Stay in your lane.** Review only your focus area. Other reviewers cover the rest.
- **Review the change, not the codebase.** Pre-existing problems the change doesn't
  touch or worsen are out of scope.
- **CHANGES means blocking.** Use it only for problems that must be fixed before
  merge, each with a concrete required change. Everything else is a non-blocking
  suggestion and doesn't affect the verdict.
- **Later reviews converge.** If round.md gives you a diff since your last review,
  start there: check whether each of your previous blocking findings was fixed, and
  read the rest of the change only for context. Raise new blocking findings only for
  code that changed since your last review or for serious problems you missed. Don't
  move the goalposts.

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

## Previous findings        (when you have a last review)
- <finding> — fixed / not fixed

## Suggestions (non-blocking)
- …
```

## When you finish

Reply with one line only, such as `round-2/review-security.md — CHANGES (2 blocking)`.
Everything else belongs in the file.
