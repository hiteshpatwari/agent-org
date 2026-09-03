# Agent Org V2 — Multi-Provider Execution and Cross-Provider Verification

## Objective

Add Anthropic as a first-class `AgentProvider`, preserve V1.2 guarantees, and add deterministic role-level provider routing without duplicating orchestration.

## Scope

- Anthropic adapter with structured output, neutral tools, usage, errors, and cancellation.
- Provider configuration, credentials, model selection, and `providers` inspection.
- Runtime-owned per-role routing and persisted configuration snapshots.
- Cross-provider provenance and optional review-diversity policy.
- Deterministic adapter/routing/provenance/resume tests and documentation.

## Non-goals

No execution-backend abstraction, automatic provider fallback, distributed resilience, auto-merge/deploy, or weakening of V1.2 evidence and workspace controls.

## Milestones

1. Audit provider-neutral contracts and add Anthropic adapter.
2. Extend configuration/CLI routing and provider inspection.
3. Enforce diversity and resume routing invariants.
4. Add deterministic coverage and opt-in live matrix documentation.

## Progress

- 2026-09-02: V2 specification reviewed; current orchestration is already provider-neutral at the port boundary, while configuration only permits `mock` and `openai` and the CLI resolves one provider globally. Implementation begins with the adapter and capability/configuration audit.
- 2026-09-02: Added `AnthropicProvider` using the official SDK behind the neutral `AgentProvider` contract, including message/tool continuation, JSON structured-result normalization, usage/cost mapping, cancellation, and normalized errors. Extended provider configuration, built-in defaults, CLI composition, `.env.example`, provider inspection, role-level provider/model flags, README, and provider docs. Added fake-client adapter tests; 53 deterministic tests pass (one opt-in live skipped).

## Verification

Run build, typecheck, lint, deterministic tests, evals, and diff checks. Live Anthropic tests remain explicitly opt-in and require `ANTHROPIC_API_KEY`.
