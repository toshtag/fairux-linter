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

3. Mark the task complete. This runs verify and, on pass, records a `done` event under `.code-pact/state/events/`:
   ```sh
   code-pact task complete <task-id> --agent claude-code
   ```
   If verify fails, this command exits 1 and no progress event is recorded.
   If a `done` event already exists, it is a no-op (`already_done: true`).

4. Report the result to the user.

> The low-level `code-pact verify --phase <p> --task <t>` is still available if you need to inspect verify output without recording a progress event.
>
> Run `code-pact validate --json` to check overall project state (schema, manifest, plan integrity) before starting a non-trivial task.
>
> **Low-level command:** `code-pact pack` is stable, but `code-pact task context <task-id>` is the preferred agent-facing entry.

## Agent contract

The canonical code-pact workflow has three axes. A conforming agent honors all three. See [`docs/cli-contract.md`](https://github.com/toshtag/code-pact/blob/main/docs/cli-contract.md) for the full envelope reference.

Use `data.commands.context` exactly as returned by `task prepare`. Do not reconstruct, widen, or replace the resolved context budget. Budgeted context may contain deterministic structural projections. Use the projected form first. Retrieve an exact original section only when a specific missing detail blocks the task and `data.deferred_context.retrieve_command` is non-null; otherwise do not construct a retrieval command from the manifest reference.

### When to invoke code-pact

Bootstrap once (CI-friendly, all non-interactive):

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

Per task (recommended entry point: `task prepare`):

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

# CI: use --audit-strict with --base-ref <default-branch> and --json so the audit compares against the merge-base when the working tree is clean.
```

For sequencing guidance, `code-pact task runbook <id> --json` and `code-pact phase runbook <id> --json` are read-only.

Activation rules (how the agent should behave):

- When the user names a task to implement (e.g. "work on P1-T1"), start with `task prepare`.
- If `next_action.type` is `wait_for_dependencies`, do not implement — resolve the blocking tasks or re-run `task prepare`.
- On `CONTEXT_OVER_BUDGET`, do not widen context unasked; report the budget, a task split, or the minimum achievable bytes.
- Run `task finalize --write` only after `task complete` has recorded the `done` event.

### What to verify first

Before implementing:

- After `task prepare --json`, read `data.recommendation`.
- After `recommend --json`, read `data`.
- Treat that recommendation object as an execution profile, not a report:
  - `tier` / `modelId` → continue, switch model, or — when the runtime **cannot switch model** — report the limitation rather than silently ignoring the recommendation.
  - `effort` → reasoning depth. `planningRequired` → write a plan before editing when true.
  - `lifecycleMode` → choose the loop: `full_loop` (prepare→start→complete→finalize), `decision_loop` (resolve the decision ADR first), or `record_only`.
- `record_only` is a lighter *loop*, not lighter verification: do **not** skip the project verification commands. Implement normally, run verification, then record honest completion with `task record-done --evidence "..."` (which still requires evidence and honors the decision gate).
- Read the task's `writes` field. Mirror real intent into it so the `write_audit` advisory has a useful signal.

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
- **task complete verification failure** (from `task complete --json --detail agent`) — `error.code` is `VERIFICATION_FAILED` (exit 1). Read `error.cause_code` first: `COMMANDS_FAILED` → fix the failing verification command; `DECISION_REQUIRED` → a `requires_decision` task needs an accepted ADR (write/accept it); `ABORTED` → retry only after the interruption is resolved.
- **standalone verify failure** (from `verify --json --detail agent`) — `error.cause_code` is guaranteed only for cancellation (`ABORTED`). For ordinary failures, branch on `data.failure.kind`: `command_failed` → fix the failing command; `timed_out` → investigate timeout or a hanging command; `decision_required` → resolve the required ADR; `invalid_state` → read `data.failure.check` and `data.failure.reason`.
- For `invalid_state`, representative checks are `progress_event` (a done event is missing or the ledger consistency needs attention; usually inspect the proper `task complete` path) and `task_status` (progress indicates completion but the design task status is not `done`; inspect the `task finalize` path). Read `data.failure.reason` before choosing an action.
- For agent-detail verification failures, `error.message` is intentionally short. Diagnose in this order: `data.failure.kind`, `data.failure.check`, `data.failure.reason`, `data.failure.fingerprint` (when present), `data.failure.stderr_excerpt` (when present), `data.failure.stdout_excerpt` (when present), `data.failure.evidence_available`, `data.failure.evidence_error`, then `data.failure.retrieve_command`.
- `data.prior_local_signal` means only that the same failure fingerprint is retained in the bounded local store (`exact_match_count`, `last_observed_at`). It does not describe previous repair attempts or hypotheses; do not infer them. If the current conversation or diff proves the same change is being rerun unchanged, avoid that rerun. If `stopOnRepeatedFingerprint` is true, follow that stop contract first.
- `fingerprint`, excerpts, and Evidence fields are optional and usually exist only for command-output failures. Do not treat their absence on `invalid_state`, decision, preflight, or configuration failures as a new error.
- Do not retrieve full evidence by default. Use `data.failure.retrieve_command` only for command-output failures when the excerpts are insufficient to decide the fix.
- **missing context pack** — `code-pact task prepare <task-id> --agent <name> --json` rebuilds the pack in the agent profile's `context_dir` (default `.context/<agent>/<task-id>.md`). Pass `--dry-run` to inspect the path without writing.
- **adapter drift** (from `code-pact adapter doctor` or `code-pact adapter conformance <agent>`) — the installed adapter files diverged from the manifest, or the agent contract surface is incomplete. Re-run `code-pact adapter upgrade <agent> --write` (use `--accept-modified` to preserve manual edits).
- **`LOCK_HELD`** — another code-pact mutation is in progress. Wait and retry; `data.lock_holder` identifies the holder.
- **`TASK_FINALIZE_NOT_ELIGIBLE`** — route via `code-pact task complete <task-id>` first; the derived state then advances.
- **`WRITES_AUDIT_STRICT_FAILED`** — `--audit-strict` plus at least one `TASK_WRITES_AUDIT_*` warning. Either (a) fix the declared writes so the audit returns clean, or (b) drop `--audit-strict` and document the deviation. The design YAML is **not** mutated on this failure path (`applied: false`).
- **`CONFIG_ERROR`** — structural argument problem (mutually exclusive flags; missing positional; `--audit-strict` / `--base-ref` without `--json`; `--from-file` + `--stdin` together; etc.). Re-read the command surface.

- After a failure, read the existing repair policy: `data.recommendation.repairPolicy` from `task prepare --json`, or `data.repairPolicy` from `recommend --json`.
- If `mode` is `disabled`, do not automatically repair.
- If `mode` is `bounded`, repair only `command_failed`, and only while `maxRepairAttempts` permits the single attempt.
- Keep `same_model_same_effort_same_context`: do not change model, effort, or context before that first repair.
- Use `failure_delta`: the Failure Capsule plus the current diff. Do not rerun `task prepare`, `task context`, or repository-wide discovery just to expand context.
- The nonretryable kinds are terminal for bounded repair: `timed_out`, `aborted`, `decision_required`, `unsafe_write`, `invalid_state`, and `unknown`.
- Fetch full evidence only when excerpts are insufficient; do not fetch it by default.
- If `stopOnRepeatedFingerprint` is true and the same fingerprint recurs, stop.
- When `afterExhaustion` is `use_allowed_escalation`, consult `data.recommendation.allowedEscalation` from `task prepare --json`, or `data.allowedEscalation` from `recommend --json`.

## Model selection

- **balanced_coding** → `claude-sonnet-4-6`
  - Use for: feature, refactor
  - Effort: low | medium | high
- **cheap_mechanical** → `claude-haiku-4-5`
  - Use for: docs, formatting
  - Effort: low
- **highest_reasoning** → `claude-opus-4-7` (thinking-capable)
  - Use for: architecture, high_ambiguity, weak_verification
  - Effort: medium | high


## Model guidance (opus-4.7)

**Effort levels:**
- `high` — complex architecture decisions, high-ambiguity tasks, or large context
- `medium` — standard feature work
- `low` — small mechanical tasks (`type: refactor`, `expected_duration: short`)

**Thinking:** For complex or `ambiguity: high` tasks, rely on the model's adaptive thinking and the effort level rather than a fixed manual thinking budget. See the model's current Anthropic documentation for its exact thinking support.

## Skills

Skills are stored in `.claude/skills/`.
Each `.md` file in that directory is automatically loaded as a slash command.

## Hooks

Hooks are stored in `.claude/hooks/`.

## Project-specific conventions

> Replace this section with your project's actual conventions.
> See `design/constitution.md` and `design/rules/` for the source of truth.

- Follow `design/rules/coding-style.md` for code style.