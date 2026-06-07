# AGENTS.md

Behavioral guidelines for coding agents working in this repository.

## Project Context

- `README.md` is the single source of truth for current zstrategy system behavior, architecture, terminology, commands, APIs, and thesis writing.
- Read `README.md` before touching code or current documentation.
- Do not read docs under `docs/archive/` by default. Archived docs are historical only; read them only when the user explicitly asks for historical context.
- If any other document conflicts with `README.md`, prefer `README.md`.
- Use `intent` for current product, code, API, and UI language. Treat `strategy` as legacy terminology unless the user explicitly asks about historical material.

## 1. Think Before Coding

Do not assume. Do not hide confusion. Surface tradeoffs.

Before implementing:

- State assumptions explicitly when they matter.
- If multiple interpretations exist, present them rather than silently choosing.
- If a simpler approach exists, say so.
- If something is unclear and a wrong assumption would be risky, stop and ask.

## 2. Simplicity First

Use the minimum code that solves the problem.

- No features beyond what was asked.
- No abstractions for single-use code.
- No speculative configurability.
- No error handling for impossible scenarios.
- If a solution becomes much larger than the problem, simplify it.

## 3. Surgical Changes

Touch only what the task requires.

When editing existing code:

- Do not improve adjacent code, comments, or formatting unrelated to the task.
- Do not refactor unrelated code.
- Match existing style.
- Mention unrelated dead code or risks instead of deleting them.

When your changes create unused imports, variables, functions, or files, remove only the unused items caused by your changes.

## 4. Goal-Driven Execution

Turn tasks into verifiable goals.

Examples:

- "Add validation" means add or update tests for invalid inputs, then make them pass.
- "Fix a bug" means write or identify a failing case, then make it pass.
- "Refactor X" means preserve behavior and run the relevant checks.

For multi-step tasks, use a short plan:

```text
1. Step -> verify: check
2. Step -> verify: check
3. Step -> verify: check
```

Loop until the stated checks pass or a real blocker is identified.
