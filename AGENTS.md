# Repository Instructions

## Architectural principles

- Keep the orchestration core independent of OpenAI, Anthropic, Cursor, Copilot, Windsurf, and future providers.
- Provider-specific SDK types and behavior belong only in `packages/providers` adapters.
- Providers generate decisions or neutral tool requests; tools perform effects through the runtime's permission checks.
- Prefer durable, schema-validated records over conversation state or unstructured handoffs.
- Evidence means reproducible receipts, tests, diffs, artifacts, and review findings—not an agent's confidence.
- An implementation agent can never approve its own work. Enforce separation of duties in domain code.
- The human Engineering Manager retains ultimate authority. Security-sensitive actions must be representable as approval gates.
- Choose the simplest local solution that proves the workflow. Do not add distributed infrastructure without a demonstrated need.

## Package boundaries

- `core` owns provider-free domain schemas, invariants, state transitions, authorization, and ports.
- `providers` implements provider adapters and may depend only on `core` plus provider SDKs.
- `tools` implements effectful tools and may depend only on `core` plus narrow implementation libraries.
- `runtime` implements orchestration and persistence against core ports; it must not import concrete providers or tools.
- `cli` is the composition root that injects providers, tools, and storage into runtime.

Do not leak SDK request/response types, provider session identifiers, or provider tool formats across these boundaries.

## Engineering expectations

- Keep TypeScript strict and validate all external/config/provider/persisted data at runtime.
- Add deterministic tests for state changes, negative authorization cases, evidence guards, persistence integrity, and package boundaries.
- Ordinary tests must not call real LLM APIs. Live adapter tests must be explicitly opted into.
- Preserve the append-only audit history and immutable artifact hashes.
- Document limitations honestly, especially where application-layer controls are not an OS sandbox.
- Record significant architectural decisions as durable Decision records or ADRs.

## Execution plans

Substantial architectural work, cross-package refactors, storage changes, and security-sensitive features require an ExecPlan following `.agent/PLANS.md`. Update the plan as implementation changes and finish its retrospective after verification.
