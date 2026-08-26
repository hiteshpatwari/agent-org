# Provider model

## Neutral contract

`AgentProvider` exposes capabilities, session creation, neutral execution turns, cancellation, and session close. A turn yields either neutral tool calls or one structured value. Core sees no native response, request, error, function-call, or session type.

Provider/model choice is per agent. `.agent-org/organization.yaml` declares adapter policies such as default model, timeout, retry limit/backoff, and optional operator-maintained token prices. Agent YAML selects a provider and optional model; CLI `--provider` and `--model` are whole-run overrides.

The ledger distinguishes configured provider ID, actual returned model, attempts, retry count, latency, token usage, estimated cost when rates are configured, and normalized error records. That metadata is sufficient for a future policy requiring a different review provider for high-risk work.

## OpenAI adapter

`OpenAIProvider` uses the official TypeScript SDK and Responses API only in `packages/providers`. It:

- translates neutral dotted tool names to collision-checked provider-safe names and reverses the mapping;
- maps tool results to `function_call_output` items and keeps continuation state adapter-local;
- supplies strict generated JSON Schema for structured output;
- keeps mission/policy in privileged instructions and sends repository context as labeled untrusted input;
- normalizes authentication, exhausted quota, rate limit, timeout, network, model access, cancellation, refusal, incomplete response, malformed output, invalid arguments, and unknown tools;
- maps token usage and optional configured cost rates into neutral usage;
- accepts an abort signal and disables hidden SDK retries.

The default configured model is `gpt-5.4-mini`. Credentials come from `OPENAI_API_KEY`; `.env.local` is ignored and loaded only when OpenAI execution is selected.

## Retry semantics

Retry policy is visible in runtime records. A retryable provider failure can restart only before local tool effects. Once any write or command receipt exists, an ambiguous failure interrupts the run for durable resume instead of blindly replaying effects. A syntactically valid provider response that fails the canonical output contract receives a corrective turn in the same session without resending prior tool results.

Clock and sleep dependencies are injectable so timeout/backoff tests remain deterministic.

## Mock and eval execution

`MockProvider` follows the same Chief/worker/tool/result protocol and supports explicit deterministic verification/review decision sequences. It does not bypass tools or manufacture runtime provenance. `evals/*/case.json` asserts workflow invariants, chronology, independence, evidence freshness, completion, and rework rather than exact prose.

Normal tests never call an API. `OPENAI_LIVE_TEST=1` gates the adapter smoke test, while the CLI real workflow is an explicit usage-bearing command.

## Adding another provider

A new adapter belongs in `packages/providers`, implements the neutral port, declares capabilities honestly, normalizes native errors, translates tools internally, and adds fake-client contract tests. Adding it must not require task, authorization, evidence, tool, persistence, or runtime imports of its SDK.
