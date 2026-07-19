# Claude Code — Project Instructions

> This file is managed by [code-pact](https://github.com/toshtag/code-pact).
> Edit the sections marked "Project-specific" to reflect your project's conventions.

## How to work on a task

0. Prepare the task — the single per-task entry point. One call returns the current state, the execution recommendation (model tier, effort, planning posture, budget), the context pack metadata, a structured `next_action`, and a `commands` dictionary with the exact next commands to run:
   ```sh
   code-pact task prepare <task-id> --agent claude-code --json
   ```
   `recommend` and `task context` remain available as standalone diagnostics, but `task prepare` runs both for you and returns their results in one envelope. Drive the rest of the lifecycle from the returned `commands` dictionary.

1. Fetch the context pack directly only if you need it outside `task prepare` (diagnostic — `task prepare` already reports its metadata):
   ```sh
   code-pact task context <task-id> --agent claude-code
   ```

2. Implement the task.

3. Mark the task complete. This runs verify and, on pass, appends a `done` event to `.code-pact/state/progress.yaml`:
   ```sh
   code-pact task complete <task-id> --agent claude-code
   ```
   If verify fails, this command exits 1 and progress.yaml is left unchanged.
   If a `done` event already exists, it is a no-op (`already_done: true`).

4. Report the result to the user.

> The low-level `code-pact verify --phase <p> --task <t>` is still available if you need to inspect verify output without recording a progress event.
>
> Run `code-pact validate --json` to check overall project state (schema, manifest, plan integrity) before starting a non-trivial task.
>
> **Low-level command:** `code-pact pack` is stable, but `code-pact task context <task-id>` is the preferred agent-facing entry.

## Agent contract

The canonical code-pact workflow has three axes. A conforming agent honors all three. See [`docs/cli-contract.md`](https://github.com/toshtag/code-pact/blob/main/docs/cli-contract.md) for the full envelope reference.

### When to invoke code-pact

Bootstrap once (CI-friendly, all non-interactive — v1.6+):

```sh
code-pact init --non-interactive --agent claude-code --locale en-US --json

# plan brief: three pairwise-mutually-exclusive modes
code-pact plan brief --from-file brief.yaml --json
# OR: cat brief.yaml | code-pact plan brief --stdin --json
# OR: code-pact plan brief --what "..." --who "..." --differentiator "..." --json

# plan constitution: same three-mode shape
code-pact plan constitution --from-file constitution.yaml --json
# OR: code-pact plan constitution --description "..." --principle "..." --principle "..." --json
```

Per task (v1.11+ recommended entry point: `task prepare`):

```sh
# Single entry point — returns current state, recommendation,
# context pack metadata, structured next_action, and a commands
# dictionary listing every per-task verb.
code-pact task prepare <task-id> --agent claude-code --json

# Lifecycle verbs the agent invokes based on the prepare response:
code-pact task start    <task-id> --agent claude-code
# ... implement ...
code-pact verify --phase <p> --task <task-id>
code-pact task complete <task-id> --agent claude-code
code-pact task finalize <task-id> --write --json

# Supporting diagnostics:
code-pact task context <task-id> --agent claude-code
code-pact recommend --phase <p> --task <task-id> --agent claude-code --json
code-pact validate --json

# CI: pair --audit-strict with --base-ref <default-branch> so the audit compares against the merge-base when the working tree is clean.
```

For sequencing guidance, `code-pact task runbook <id> --json` and `code-pact phase runbook <id> --json` are read-only.

Activation rules (how the agent should behave):

- When the user names a task to implement (e.g. "work on P1-T1"), start with `task prepare`.
- If `next_action.type` is `wait_for_dependencies`, do not implement — resolve the blocking tasks or re-run `task prepare`.
- On `CONTEXT_OVER_BUDGET`, do not widen context unasked; report the budget, a task split, or the minimum achievable bytes.
- Run `task finalize --write` only after `task complete` has recorded the `done` event.

### What to verify first

Before implementing:

- After `task prepare --json` (or `recommend --json`), read `data.recommendation` and treat it as an execution profile, not a report:
  - `tier` / `modelId` → continue, switch model, or — when the runtime **cannot switch model** — report the limitation rather than silently ignoring the recommendation.
  - `effort` → reasoning depth. `planningRequired` → write a plan before editing when true.
  - `lifecycleMode` → choose the loop: `full_loop` (prepare→start→complete→finalize), `decision_loop` (resolve the decision ADR first), or `record_only`.
- `record_only` is a lighter *loop*, not lighter verification: do **not** skip the project verification commands. Implement normally, run verification, then record honest completion with `task record-done --evidence "..."` (which still requires evidence and honors the decision gate).
- Read the task's `writes` field. Mirror real intent into it so the v1.6+ `write_audit` advisory has a useful signal.

Before `task finalize --write`:

- Run the same command with `--json` first (no `--write`) to inspect `data.write_audit`. If `outside_declared` or `declared_unused` is non-empty, fix the declared writes first.
- For branch-level audit, pass `--base-ref main` (requires `--json`).
- In CI (working tree is clean / commits are pushed), pair `--audit-strict` with `--base-ref <default-branch>` so the audit compares against the merge-base. Without `--base-ref` the audit only sees uncommitted changes and `TASK_WRITES_AUDIT_DECLARED_UNUSED` will fire for any task whose declared writes the working tree does not currently dirty: `task finalize <id> --audit-strict --write --json --base-ref origin/main`.
- For local pre-commit review (uncommitted working tree is the audit target), drop `--base-ref`: `task finalize <id> --audit-strict --write --json`.

At PR boundaries:

- `code-pact validate --json` for project integrity.
- `code-pact plan lint --json` for advisory; `--strict` promotes warnings to exit-relevant (distinct from `--audit-strict`).

### How to handle failures

- **blocked dependency** (from `task prepare`) — `next_action.type` is `wait_for_dependencies` and `blocked_by` lists the upstream task ids. Either resolve those tasks first (a real block) or `code-pact task resume <task-id>` if the block was a manual `task block` whose reason is resolved.
- **verification failure** (from `task complete`) — the phase's `verification.commands` failed (`VERIFICATION_FAILED`). Fix the failing command and re-run; `task complete` is idempotent.
- **missing context pack** — `code-pact task prepare <task-id> --agent <name> --json` rebuilds the pack at `.context/<agent>/<task-id>.md`. Pass `--dry-run` to inspect the path without writing.
- **adapter drift** (from `code-pact adapter doctor` or `code-pact adapter conformance <agent>`) — the installed adapter files diverged from the manifest, or the agent contract surface is incomplete. Re-run `code-pact adapter upgrade <agent> --write` (use `--accept-modified` to preserve manual edits).
- **`LOCK_HELD`** — another code-pact mutation is in progress. Wait and retry; `data.lock_holder` identifies the holder.
- **`TASK_FINALIZE_NOT_ELIGIBLE`** — route via `code-pact task complete <task-id>` first; the derived state then advances.
- **`WRITES_AUDIT_STRICT_FAILED`** — `--audit-strict` plus at least one `TASK_WRITES_AUDIT_*` warning. Either (a) fix the declared writes so the audit returns clean, or (b) drop `--audit-strict` and document the deviation. The design YAML is **not** mutated on this failure path (`applied: false`).
- **`CONFIG_ERROR`** — structural argument problem (mutually exclusive flags; missing positional; `--audit-strict` / `--base-ref` without `--json`; `--from-file` + `--stdin` together; etc.). Re-read the command surface.

## Model selection

- **balanced_coding** → `claude-sonnet-4-6`
  - Use for: feature, refactor
  - Effort: low | medium | high
- **cheap_mechanical** → `claude-haiku-4-5`
  - Use for: docs, formatting
  - Effort: low
- **highest_reasoning** → `claude-opus-4-7` (thinking enabled)
  - Use for: architecture, high_ambiguity, weak_verification
  - Effort: medium | high


## Model guidance (opus-4.7)

**Effort levels:**
- `high` — large context, complex architecture decisions, or tasks with `ambiguity: high`
- `medium` — standard feature work (default)
- `low` — small mechanical tasks (`type: refactor`, `expected_duration: short`)

**Extended thinking:** Extended thinking is supported. Enable it for tasks flagged `ambiguity: high` or `context_size: large`.

## Skills

Skills are stored in `.claude/skills/`.
Each `.md` file in that directory is automatically loaded as a slash command.

## Hooks

Hooks are stored in `.claude/hooks/`.

## Project-specific conventions

> Replace this section with your project's actual conventions.
> See `design/constitution.md` and `design/rules/` for the source of truth.

- Follow `design/rules/coding-style.md` for code style.