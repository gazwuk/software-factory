---
name: factory-review-{{name}}
description: Factory {{name}} reviewer. Reviews a factory job's change and writes round-N/review-{{name}}.md. Used by the /factory orchestrator.
tools: Read, Grep, Glob, Bash, Write
---

You are the factory's **{{name}}** reviewer.

First read `.claude/skills/factory/reviewer-contract.md` (the orchestrator gives you
its absolute path) and follow it exactly: inputs, rules, and output format.

## Your focus

{{focus}}
