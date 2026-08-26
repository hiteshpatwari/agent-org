# V1 architecture

## Organization and package boundaries

The durable organization remains Human → Chief Engineer → Developer → Tester → Reviewer → Chief acceptance. V1 did not add roles or replace the V0 task model.

The CLI is the composition root. `runtime` depends only on neutral `core` ports; concrete OpenAI/mock providers and local tools remain in their adapter packages. Provider SDK request/response/session/tool types never enter the ledger or runtime APIs.

```text
                         core
                 schemas, policy, ports
                   ↑       ↑       ↑
             providers   tools   runtime
                   \       |       /
                         cli
```

## Execution sequence

1. The runtime creates a ledger with lifecycle `INITIALIZING` and a non-secret effective configuration snapshot.
2. The workspace manager copies the template through a temporary path, initializes a baseline Git repository, atomically renames it, and returns a canonical file/hash manifest.
3. The configured Chief provider returns one strict task proposal. Core checks exact requirement/criterion coverage and validates the task graph.
4. The runtime advances the durable task stage. Each provider call records a start/end attempt, normalized failure, duration, model, usage, and retry count.
5. Neutral tool requests pass through role allowlists. Every effect yields a receipt with trusted principal, iteration, and resulting workspace hash.
6. Developer results, tester verification, reviewer findings, and artifacts link directly to their producing agent run, task iteration, and workspace state.
7. Failed verification or `REQUEST_CHANGES` enters bounded rework. Findings are shown to the next Developer; prior persuasive Developer reasoning is excluded from tester/reviewer context.
8. Chief acceptance requires current-iteration verification and review, known receipts, required test command evidence, criterion coverage, matching workspace state, artifact integrity, and no pending human approval.

## Context strategy

`AgentContextBuilder` constructs a projection for each role:

- Chief: objective, requirements, acceptance criteria, bounded repository manifest, and no worker reasoning.
- Developer: assigned task, relevant file manifest, allowed tools, and prior independent findings only during rework.
- Tester: acceptance criteria, required command IDs, current workspace state, and implementation receipts; no Developer narrative.
- Reviewer: requirements, current workspace state, test evidence, and repository evidence; no persuasive implementation summary.

Provider policy and role mission are privileged instructions. Repository excerpts, manifests, diffs, and tool output are labeled untrusted input data and never interpolated into that privileged policy.

## Structured communication

Canonical Zod contracts define Chief plans, worker results, verification, and reviews. Runtime generates the JSON Schema supplied to providers from those same contracts and adapts it to the strict provider subset. Model-authored provenance fields are absent; runtime stamps `runId`, `taskId`, `agentId`, `agentRunId`, iteration, and workspace hash.

Syntax validation is followed by semantic checks. For example, `SUCCEEDED` cannot contain blockers, `PASS` cannot contain failed tests, and `APPROVE` cannot contain blocking/high-severity findings. Invalid output receives a bounded corrective turn; exhaustion fails safely.

## Rework and evidence freshness

Every rework cycle increments `task.iteration`. Result, receipt, verification, review, artifact, and agent-run records carry that iteration and workspace hash. Current task references point only to the accepted cycle while prior records remain append-only for audit. A passing receipt from iteration 0 cannot satisfy iteration 1.

The canonical workspace state includes sorted tracked and untracked files (excluding `.git` and generated dependency/build directories), file sizes, SHA-256 hashes, and a manifest hash. This avoids treating `git diff`—which may omit untracked files—as the sole change record.

## Durability and recovery

Each JSONL entry stores revision, previous revision, event, resulting ledger, and SHA-256 of the raw stored state. Raw state is verified before V1 schema defaults are applied, preserving V0 readability. `ledger.json` is a repairable cache.

Lifecycles are `INITIALIZING`, `RUNNING`, `INTERRUPTED`, `COMPLETED`, and `FAILED`. On resume, a per-run exclusive lock prevents a second writer; incomplete agent runs are marked failed, a `RUN_RESUMED` event is appended, and execution continues from the durable task stage in the existing workspace. Completed stages are not replayed. Final-report generation is idempotent by content hash.

Filesystem effects and journal commits are not one transaction. A process can still stop after a local write but before its receipt commit. Resume gives the agent the current workspace manifest so it can reconcile partial state; V1 does not claim exactly-once native effects.
