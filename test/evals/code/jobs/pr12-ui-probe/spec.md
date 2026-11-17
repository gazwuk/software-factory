# Render and measure UI changes

## Goal
Before the UI and UX reviewers run, the factory renders every screen and state the spec
names, at each configured viewport and theme, measures it, and blocks only on problems
the change introduced. Reviews must answer every measured item, and the factory checks
that they did.

## Context
- `template/.claude/skills/factory/round.mjs` — runs checks and writes round.md.
- `template/.claude/skills/factory/runner.mjs` — re-runs incomplete reviews.
- `template/.claude/agents/` — the spec-writer, builder and reviewer definitions.

## Scope
- spec.md gains a `## Screens` table (screen, state, how to reach it).
- `probe.mjs`: serves the worktree with `ui.serve` and visits each screen/state ×
  viewport × theme (at most `ui.maxVisits`) with the repo's own Playwright and
  axe-core. It records axe violations, overflow, page and console errors, failed
  requests, CLS, the Tab order with focus visibility and traps, and a screenshot per
  visit. Failing visits are repeated on the merge base, so pre-existing problems don't
  block and ones it can't compare are unverified. Writes `probe.json` and `probe.md`;
  screenshots are gitignored.
- `probe.mjs check-review`: checks that a review answers every item it owns and lists
  every screenshot it owes.
- `worktree.mjs`: `config.worktree.link` (symlink gitignored files from the main
  checkout, refusing any link that isn't gitignored in the worktree, so secrets can't be
  committed) and `config.worktree.setup`.
- Static gates in `config.checks`: `{ command, files, scope }`; with `scope: "lines"` a
  gate fails only on problems on lines the change added or changed.
- `round.mjs diff`: the review diff with each line's number in its file.
- Reviewer contract and UI/UX reviewer rewrites; a seeded-defect reviewer benchmark.

## Acceptance criteria
1. Screens in the Screens table are visited at each viewport and theme; screens with no
   URL are listed as not visited.
2. A problem the change introduces blocks the round; a problem already on the merge
   base doesn't; a problem that can't be compared is reported as unverified.
3. A change that breaks the app's startup blocks the round.
4. Each visit takes a screenshot, and check-review checks that the review lists the ones
   it owes.
5. With no `worktree.setup`, a change to dependency files is reported unverified rather
   than compared on the branch's packages.
6. The Tab order is recorded, with focus visibility and traps.
7. A `scope: "lines"` gate fails only on problems on lines the change added or changed;
   older problems are counted but don't block.
8. The review diff prints each line's number in its file.
9. A link that isn't gitignored in the worktree is refused, so secrets can't be
   committed from it.
