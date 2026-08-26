# V1 Real Agent Execution

## Purpose and user-visible outcome

V1 proves that the provider-independent organization created in V0 can complete a realistic software-engineering objective with a real OpenAI model while preserving durable state, role separation, constrained tools, structured evidence, independent verification, and restart recovery. The deterministic mock provider remains the default for ordinary tests. A user can configure provider and model per agent, run or resume an objective, and query runs, tasks, reviews, events, evidence, provider attempts, token usage, and rework from the CLI.

## Scope and non-goals

In scope are a production OpenAI Responses API adapter, neutral provider failure and attempt records, bounded retry and cancellation, explicit role-specific context, controlled repository search, per-agent provider routing, resumable orchestration, bounded rework, a realistic multi-file TypeScript bug-fix fixture, deterministic invariant evals, useful CLI run inspection, security hardening, and documentation.

V1 does not add roles, a dashboard, distributed scheduling, a container sandbox, arbitrary shell access, Anthropic support, or a second-provider independence policy. It does not treat application-layer path and command checks as an OS security boundary.

## Assumptions and constraints

- Node 22, pnpm, TypeScript strict mode, Zod validation, JSONL journals, and local workspaces remain the implementation base.
- API credentials come only from process environment or the ignored local environment file loaded by the CLI. Prompts and raw provider responses are never persisted.
- Normal tests make no network calls. Live tests and the realistic real-provider run are opt-in.
- The current local OpenAI credential is usable syntactically, but the most recent live request was rejected for exhausted project credits. V1 will still attempt the requested live acceptance run and record a safe normalized failure if billing remains unavailable.
- All implementation work follows the package dependency rules in `AGENTS.md`.

## Current repository state and V0 audit

The untouched baseline is clean on `main`, builds successfully, passes typecheck and lint, and has 29 passing deterministic tests plus one skipped opt-in live test.

Correct V0 properties:

- Core schemas, authorization, task transitions, evidence guards, append-only event history, snapshot hashing, and package-boundary tests already exist.
- Developer, tester, and reviewer identities are distinct, and the reviewer cannot approve its own implementation.
- Invalid transitions, missing dependencies, unauthorized privileged actions, tester failure, incomplete verification, pending approvals, and objective completion are guarded in domain code.
- Runtime imports neutral ports only; OpenAI SDK types are isolated under `providers`; CLI is the composition root.
- Tool calls are role-authorized and workspace-relative. Shell execution uses configured command identifiers rather than arbitrary model-supplied commands.
- The mock provider is deterministic and live API tests are opt-in.

Repairs required before V1 is justified:

- `REQUEST_CHANGES` reaches `CHANGES_REQUESTED`, but the runtime throws instead of reopening, reimplementing, reverifying, and rereviewing.
- A provider or agent failure leaves a task at its active stage with a failed agent run, but there is no resume command or stage-driven recovery. Already-completed work cannot be reliably resumed without starting a new run.
- Provider timeout uses `Promise.race` without aborting the underlying request. Errors are raw, retries are absent, and malformed structured output is not safely classified or retried.
- Agent context is assembled inline and is nearly identical for every role. Reviewer input is not explicitly separated from developer reasoning.
- One global provider is injected into runtime; configured agent provider preferences are ignored.
- Successful implementation output is not cross-checked strongly enough against successful write receipts and the actual diff.
- Tool and provider error text lacks one centralized secret-redaction boundary. Sensitive workspace paths require explicit denial.
- Run records lack provider attempts, retry/error details, latency, files changed, and a CLI run index.
- There is no controlled repository-search tool, realistic fixture, or invariant-oriented eval suite.

These are extension failures at provider, context, recovery, and evidence seams. They do not invalidate the core organization or justify a rewrite.

## Architecture and package-boundary decisions

### Core

`core` will add only provider-neutral contracts and durable schemas: normalized provider errors, execution attempt metadata, structured blockers/risks/next actions, recovery and provider events, richer agent-run metrics, provider configuration, and any transition needed for bounded rework/recovery. It will continue to own authorization and evidence invariants.

The Chief Engineer will receive a real, schema-validated planning turn. Its model-authored proposal is input only: core validates task scope, dependencies, role assignment, risk, and requirement coverage before durable task creation. Chief final acceptance remains deterministic and evidence-gated, so a model cannot waive organizational invariants.

### Providers

`providers` will implement OpenAI Responses API translation, strict structured output, neutral tool requests, cancellation signals, usage/model metadata, and normalized errors. It will expose no SDK response or error types. SDK automatic retries will be disabled so retry behavior is explicit and observable in the neutral executor.

### Runtime

`runtime` will resolve a provider from agent configuration through a neutral resolver, build least-relevant role context through a dedicated context builder, execute bounded attempts, record attempts before/after retries, validate results, drive task stages until completion or a safe terminal/interrupted point, and resume an existing ledger/workspace without replaying completed stages.

Reviewer context includes requirements, repository state/diff, test evidence, and architecture decisions, but excludes persuasive developer summaries unless they are required evidence. Tester context excludes implementation reasoning. Rework context includes the prior independent findings that requested correction.

Policy and role mission remain privileged provider instructions. Bounded repository excerpts, diffs, and receipts are labeled untrusted input with path, content hash, truncation status, and a byte budget; they are never interpolated into privileged instructions. JSON Schema supplied to providers is generated from the canonical Zod output contract, or protected by explicit parity tests if the installed Zod version prevents reliable generation.

### Tools

`tools` will retain run-local Git repositories and add bounded literal repository search plus sensitive-path denial and output redaction. Existing copied run workspaces are chosen over Git worktrees for V1 because objectives start from fixture/template directories that may not themselves be registered worktrees of the orchestration repository. Each run still receives a separate directory, its own baseline Git commit, bounded path access, and durable diff. This is the simplest isolation that proves the workflow without coupling execution to the source repository. Git worktree support remains a future option for objectives sourced from an existing repository.

The workspace manager will expose a canonical change manifest that includes tracked and untracked paths, per-file hashes, and a manifest hash. Task iteration and workspace-state hash are attached to results, receipts, verifications, reviews, artifacts, and agent runs so evidence from an earlier implementation cannot satisfy a later rework cycle.

### CLI

`cli` remains the only composition root. It loads provider configuration, creates provider adapters, selects optional overrides, and injects a neutral resolver. It adds `resume` and `runs`, while existing query commands remain ledger-only and do not require API credentials.

Each run snapshots its effective non-secret agent/provider/model/retry/tool-command/rework/cost configuration. Resume uses that snapshot and refuses incompatible authority drift. A durable run lifecycle records initialization, workspace staging, running, interruption, and completion. A per-run exclusive lock rejects concurrent writers; workspace staging uses a temporary directory and atomic rename.

## Domain invariants and security boundaries

- An agent cannot test or review its own implementation; provider metadata is retained so a future high-risk rule can require different providers.
- Task completion requires passing verification, approval, required evidence, no unresolved blockers, and successful implementation receipts consistent with the workspace diff.
- Accepted result, verification, and review records must reference the latest task iteration, producing agent run, and exact workspace-state hash. Passing verification requires the configured verification command receipts; `git.diff` alone is not the canonical change manifest.
- Critical workflow state is derived only from schema-validated payloads, never prose.
- Every retry, provider failure, tool result, transition, review, rework, interruption, and resume is durable and revisioned.
- A failed or exhausted agent attempt cannot mark the task or objective complete.
- Resume continues from durable task state and existing workspace. Completed development, verification, or review stages are not blindly rerun.
- Filesystem tools resolve beneath the run workspace and reject sensitive paths such as `.env*`, `.git`, key files, and package-manager credentials. Search is literal and bounded. Persisted receipt input/output is minimized and redacted; write content is represented by path/size/hash rather than copied into every journal snapshot.
- Shell tools execute administrator-configured command IDs only. Models receive descriptions, not authority to invent commands.
- Reviewer and tester remain read-only with respect to production file writes. Dangerous actions continue to require the existing generic approval record and must block completion while pending.
- Central redaction runs before error/tool text enters ledger, events, or artifacts. Artifact content is scanned/redacted before write, and final ledger/artifact validation rejects remaining known secret shapes. Secrets are never placed in prompts intentionally and prompts are not persisted.
- Repository content is untrusted context. Agent instructions explicitly treat repository text as data and cannot expand tool permissions.
- Schema validation is followed by semantic validation: success cannot coexist with blockers/failed required receipts; verification PASS cannot include failing tests; review APPROVE cannot include blocking findings or inconsistent next actions.
- Retryable provider failures may restart only before local effects. Malformed final output uses a bounded corrective turn in the same session. Ambiguous provider failure after local effects interrupts safely unless a repeated tool-call ID can be served from the durable receipt cache. Abort completion and session-close errors cannot append late state or mask the primary failure.
- Existing V0 journals remain inspectable. Schema additions are optional/additive for stored V0 records, raw journal hashes are checked before any migration/defaulting, and compatibility is covered by a fixture test.

## Milestones and observable completion criteria

1. **Audit and architecture record.** Complete this plan, obtain independent design critique, incorporate valid findings, and add missing V0 invariant tests. Completion: audit decisions and critique disposition are recorded here.
2. **Neutral provider execution.** Add configuration, resolver, normalized errors, attempts, retry, timeout cancellation, schema retry, model/usage/latency capture, adapter-local neutral tool-name translation, Chief planning, and tests. Completion: fake-provider tests prove retryable, nonretryable, malformed, timeout, exhausted, cancellation, refusal/incomplete response, and schema parity paths without network access.
3. **Context and controlled tools.** Add explicit role contexts, safe repository search, sensitive-path denial, redaction, and stronger implementation evidence validation. Completion: tests prove context separation, capabilities, redaction, and evidence failure behavior.
4. **Stateful workflow.** Refactor orchestration into a durable stage loop with bounded `REQUEST_CHANGES`/tester-failure rework and restart resume. Completion: deterministic tests prove latest-iteration evidence, rework, independence, interruption at commit boundaries, initialization/final-report recovery, exclusive resume, partial completion, and no premature completion.
5. **Fixture, evals, and CLI.** Add the realistic multi-file TypeScript bug fixture, invariant-oriented eval definitions/runner, provider-aware run options, `resume`, `runs`, and richer inspection. Completion: deterministic fixture/evals prove implementation, tests, review, no self-review, ordered completion, and a rejection/rework case.
6. **Verification and real acceptance.** Run formatting/static/package-boundary/unit/integration/eval checks, execute deterministic demo, attempt the real-provider objective, and inspect ledger, events, diff, test receipts, reviews, and metrics. Completion: evidence supports every completion claim; external billing failure, if present, is reported as a limitation rather than disguised.
7. **Documentation and retrospective.** Update README, architecture/security/provider/eval instructions, AGENTS.md only for lasting invariants, and this plan retrospective after verified behavior exists.

## Test and verification commands

From `C:\projects\agent-org`:

    pnpm test
    pnpm typecheck
    pnpm lint
    pnpm test:coverage
    pnpm build
    pnpm agent-org run examples/simple-feature/objective.yaml
    pnpm agent-org run examples/real-bug-fix/objective.yaml --provider mock
    pnpm agent-org eval evals
    pnpm agent-org runs
    pnpm agent-org status --run <run-id>
    pnpm agent-org events --run <run-id>
    pnpm agent-org reviews --run <run-id>
    pnpm agent-org run examples/real-bug-fix/objective.yaml --provider openai --model gpt-5.4-mini

The final live command is allowed to fail only for a clearly normalized external credential/quota/network reason; the resulting interrupted run must remain inspectable and resumable.

## Demo and acceptance procedure

1. Run the realistic objective in deterministic mode and inspect its isolated workspace diff.
2. Confirm multiple files changed, configured tests executed successfully, tester evidence exists, an independent reviewer acted, Chief Engineer completion followed review, and no required blocker remains.
3. Run a separate deterministic rejection scenario and confirm findings flow into developer rework, followed by new verification and review records.
4. Interrupt a scripted provider at each active stage, reconstruct storage in a new runtime instance, resume the same run/workspace, and confirm completed stages were not repeated.
5. Attempt the same realistic objective using OpenAI. Inspect provider attempts, model, duration, tokens, tools, diff, tests, review, rework, and final state. If credits remain exhausted, inspect the normalized failure and resume readiness instead.

## Risks, recovery strategy, and unresolved decisions

- Model tool use is nondeterministic. Bounded turns, bounded output, fixed tools, schema enforcement, and evidence gates constrain but do not eliminate this risk.
- A process can stop between a local effect and journal commit. Tool receipts and Git diff make effects discoverable; resumed agents receive current repository state and must reconcile it. True transactional filesystem effects are not attempted.
- Retrying after an ambiguous provider transport failure can repeat a logical request. Automatic restart is therefore limited to attempts with no local effects; malformed output is corrected in-session; later ambiguous failures interrupt for explicit resume. Local tool calls are authorized and recorded independently; destructive/general commands are unavailable.
- Application checks do not protect against malicious native processes invoked by an allowed command. Fixture commands are repository-controlled and documented; arbitrary repositories require human review of the command catalog.
- Estimated cost is computed only when operator-maintained per-model rates are configured. Token counts remain authoritative; estimates are labeled.
- Whether to expose approval-management CLI commands is unresolved. V1 retains the generic domain gate; add CLI mutation only if the fixture needs a dangerous action.

Recovery uses the append-only journal as authority, validates the snapshot/hash chain, identifies incomplete agent runs, records interruption/resume events, reuses the existing run workspace, and advances only the durable current stage. Corrupt history fails closed and is never silently replaced.

## Progress log

- 2026-08-25: Inspected architecture, state machine, authorization/evidence guards, provider adapters, runtime, storage, tools, CLI, schemas, examples, and tests. Baseline: clean Git worktree; 29 tests passed, one live test skipped; typecheck and lint passed.
- 2026-08-25: Identified recovery, rework, context separation, provider routing/reliability, evidence, security-redaction, observability, fixture, and eval gaps. Chose incremental port/state/runtime extensions over redesign.
- 2026-08-26: Added canonical structured plans/results, provider error and attempt records, cancellation and bounded retries, per-agent provider/model configuration, adapter-local OpenAI tool translation, strict generated JSON Schema, model/usage/cost metadata, and a real Chief planning turn.
- 2026-08-26: Added role-specific context, repository search, sensitive-path denial, minimized/redacted receipts, canonical workspace manifests, iteration/state-bound evidence, semantic result guards, bounded rework, run lifecycles, configuration snapshots, atomic staging, writer locks, V0 journal compatibility, and stage-based resume.
- 2026-08-26: Added the multi-file TypeScript order-pricing fixture, deterministic scripted rejection/failure behavior, four invariant eval cases, `resume`/`runs`/metrics CLI support, and V1 architecture/provider/security documentation.
- 2026-08-26: Deterministic acceptance run `RUN-20260826225423-c5944d23` completed at revision 48: four successful role runs, nine tool receipts, three changed files, passing required test, independent approval, matching workspace hash, zero retries/errors, and four artifacts.
- 2026-08-26: Live OpenAI acceptance attempt `RUN-20260826225142-f7038c4b` reached the API and was rejected during Chief planning with HTTP 429 `QUOTA_EXHAUSTED` (no credits remaining). One 2.06-second provider attempt, zero retries, zero tokens, and zero tool effects were recorded; lifecycle is `INTERRUPTED` and resumable after billing is restored.
- 2026-08-26: Final verification passed: typecheck/build, lint, 43 deterministic tests with one opt-in live test skipped, four deterministic evals, realistic mock workflow, and coverage (83.16% statements, 67.26% branches, 88.8% functions, 87.44% lines). Added the missing `@vitest/coverage-v8` dependency so the existing coverage script is executable.

## Independent critique disposition

Independent review completed 2026-08-25. Accepted: real Chief planning; iteration and workspace-state-bound provenance; canonical tracked/untracked change manifest; run lifecycle, configuration snapshot, atomic staging, and exclusive writer; canonical schema/parity enforcement; privileged-policy versus untrusted-repository context separation; receipt/artifact secret controls; effect-boundary retry semantics; semantic output validation; direct `agentRunId` provenance; OpenAI tool-name translation and incomplete/refusal normalization; domain-owned bounded rework; V0 journal compatibility; an explicit scripted deterministic provider; and chronology/fault-injection eval assertions.

Partially accepted: dangerous-action approvals. V1 will enforce approval metadata for any configured command marked dangerous, while the shipped fixture exposes no dangerous commands. The plan will state accurately that this is an application policy gate, not a sandbox.

Deferred as disproportionate to V1: full transactional recovery for every possible orphan artifact and operating-system crash window. V1 will make artifact creation idempotent/reconcilable where practical, stage workspaces atomically, lock writers, and cover representative commit boundaries. It will document the remaining non-transactional filesystem window rather than claim exactly-once effects.

## Final implementation retrospective

V1 achieved the provider-independent real-execution architecture without rewriting V0. The most consequential repairs were making Chief planning a real structured provider turn, binding evidence to task iteration and canonical workspace state, treating context as a role-specific trust boundary, and replacing the one-shot demonstration with a durable stage loop that can rework and resume.

The implementation followed the plan with three deliberate limits. First, copied run-local Git repositories remain the isolation unit instead of worktrees because fixture templates are not branches of the orchestration repository; this preserves simpler, objective-scoped isolation. Second, filesystem effects are not transactionally coupled to journal commits, so recovery is at-least-once reconciliation rather than exactly-once execution. Third, the live workflow could not proceed past Chief planning because the configured OpenAI project has no API credits. The adapter and runtime nevertheless proved API reachability, correct quota-versus-rate-limit classification, non-retry behavior, zero local effects, durable error capture, and resume readiness.

Verification demonstrates the requested rejection path without forcing it in the successful fixture: `review-rejection` records REQUEST_CHANGES, a new iteration, fresh implementation/test/review evidence, and final approval; `failing-tests` exhausts two rework cycles and never completes. Recovery injection proves a provider crash leaves an interrupted ledger, a new runtime resumes the same workspace/stage, Chief planning is not repeated, and the failed/successful Developer runs remain auditable.

The smallest V2 recommendation is one additional provider adapter plus a core risk policy that can require the implementation and review provider instance IDs to differ. Do not add roles, a dashboard, distributed infrastructure, or generalized autonomous delegation before that independence policy is proven.
