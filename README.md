# Agent Org

Agent Org is a local, provider-independent engineering organization that executes a separation-of-duties workflow with durable evidence:

```text
Human Engineering Manager
          ↓
Chief Engineer planning
          ↓
Developer implementation
          ↓
Tester verification
          ↓
Reviewer independent review
          ↓
Chief Engineer acceptance
```

V1 can use either deterministic `MockProvider` execution or the OpenAI Responses API. Both paths use the same core task state, authorization, tool, receipt, artifact, recovery, and evidence contracts.

## Guarantees

- Implementation, testing, and review use distinct agent identities. An implementer cannot verify or approve its own work.
- Critical decisions come from strict schema-validated payloads; runtime-owned provenance is never accepted from a model.
- The Chief planning turn is model-backed, but core validates its coverage and task graph. Final acceptance is deterministic and evidence-gated.
- Test and review evidence must belong to the latest rework iteration and exact workspace-state hash.
- Provider errors, attempts, latency, model, usage, retry count, tool calls, files, reviews, and rework remain queryable.
- Interrupted runs resume their durable stage and existing workspace. Completed stages are not blindly replayed.
- Ordinary tests and evals are deterministic and make no real API calls.

## Architecture

| Package | Responsibility |
| --- | --- |
| `@agent-org/core` | Provider-free schemas, transitions, authorization, evidence, error normalization contracts, approval gates, and ports |
| `@agent-org/providers` | Deterministic mock scenarios and the isolated OpenAI adapter |
| `@agent-org/tools` | Constrained filesystem/search/fixed-command/Git effects, receipts, redaction, and workspace staging |
| `@agent-org/runtime` | Context construction, provider execution, rework/recovery loop, eval assertions, artifacts, configuration, and journal storage |
| `@agent-org/cli` | Composition root, provider/model selection, execution, resume, and inspection |

The enforced dependency graph is `core <- providers`, `core <- tools`, and `core <- runtime`; only the CLI composes concrete adapters. See [architecture](docs/architecture.md), [provider model](docs/provider-model.md), and [security model](docs/security-model.md).

## Requirements and verification

- Node.js 22+
- pnpm 10+
- Git on `PATH`

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm agent-org eval evals
```

## Deterministic demonstrations

The original small feature remains available:

```bash
pnpm agent-org run examples/simple-feature/objective.yaml --provider mock
```

The V1 fixture is a deliberately defective TypeScript order-pricing library. It requires repository inspection, changes to two production modules and a regression test, execution of a fixed Node test command, diff review, and evidence-backed acceptance:

```bash
pnpm agent-org run examples/real-bug-fix/objective.yaml --provider mock
```

The eval suite asserts outcomes and chronology rather than generated wording. It covers a simple feature, realistic bug fix, reviewer rejection followed by rework, and repeated failing verification that exhausts the rework policy.

## OpenAI configuration

Provider policy lives in `.agent-org/organization.yaml`; each agent selects a provider/model through its declarative definition. CLI flags can override all roles for one run:

```bash
pnpm agent-org run examples/real-bug-fix/objective.yaml --provider openai --model gpt-5.4-mini
```

Set `OPENAI_API_KEY` in the process environment or ignored `.env.local`. Never commit that file. The CLI loads it only for OpenAI execution. Query commands do not load provider credentials.

The adapter uses strict structured output and function tools, normalizes provider failures, disables hidden SDK retries, captures usage/model metadata, and accepts an abort signal. Automatic retries stop once a local effect has occurred; malformed final output uses a corrective turn in the same session.

## Run inspection and recovery

```bash
pnpm agent-org runs
pnpm agent-org status --run <RUN_ID>
pnpm agent-org tasks --run <RUN_ID>
pnpm agent-org inspect <TASK_ID> --run <RUN_ID>
pnpm agent-org events --run <RUN_ID>
pnpm agent-org reviews --run <RUN_ID>
pnpm agent-org resume <RUN_ID> --provider openai --model gpt-5.4-mini
```

Run data is stored under `.agent-org/state/runs/<RUN_ID>/`:

```text
ledger.json       derived current-state snapshot
events.jsonl      authoritative append-only revision/hash journal
artifacts/        immutable content-hashed, redacted reports
workspace/        isolated run-local Git repository
```

Workspace staging copies the configured template through a temporary directory, creates a baseline Git commit, and atomically renames it into the run. A single-writer lock rejects concurrent resume. V0 journals remain readable: raw stored state is hash-verified before additive V1 defaults are applied.

## Tools and security boundary

Available neutral tools are `filesystem.read`, `filesystem.write`, `filesystem.list`, `repository.search`, `shell.execute`, `git.status`, and `git.diff`. Roles receive explicit subsets. Reviewers cannot write; testers cannot write production code. Shell calls accept an administrator-defined command ID, never a model-authored command line.

Paths are resolved under the run workspace; symlink/junction escape and sensitive paths such as `.env*`, `.git`, private keys, and package credentials are denied. Persisted write receipts contain content hashes and sizes instead of full source. Common secret shapes are redacted from errors, outputs, inputs, and artifacts.

These are application controls, not an OS sandbox. An allowed native command still has the current user's operating-system authority. Arbitrary untrusted repositories require stronger process isolation.

## Intentionally unsupported in V1

- distributed queues or services;
- container/VM sandboxing;
- arbitrary shell commands;
- automatic merges, deployments, or infrastructure mutation;
- additional roles or a dashboard;
- Anthropic/Cursor/Copilot adapters;
- mandatory cross-provider review for high-risk tasks.

The next smallest step is a second provider adapter plus a core risk policy that can require implementation and review to use different provider instances.

## License

MIT. See [LICENSE](LICENSE).
