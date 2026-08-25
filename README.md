# Agent Org

Agent Org is a local, provider-independent engineering organization composed of AI-agent roles. It demonstrates a serious separation-of-duties workflow:

```text
Human Engineering Manager
          ↓
    Chief Engineer
          ↓
      Developer
          ↓
       Tester
          ↓
      Reviewer
          ↓
Chief Engineer acceptance
```

V0 is deliberately small. It proves that an implementation can be executed, tested, independently reviewed, accepted, and audited without trusting one model's confidence or keeping critical state only in a conversation.

## Core philosophy

- **Evidence over confidence:** runtime receipts, command results, Git diffs, content hashes, artifacts, and review findings are evidence.
- **Separation of duties:** the implementation agent cannot verify or approve its own work. Core domain code enforces this.
- **Provider independence:** orchestration depends on neutral ports. OpenAI SDK types exist only inside the OpenAI adapter.
- **Durable state:** every run has a ledger, append-only journal, artifacts, receipts, and agent-run metadata.
- **Structured communication:** provider output is runtime-validated. Identity and provenance are stamped by the runtime, not accepted from a provider.
- **Least privilege:** roles declare domain actions and tool names; tools enforce workspace paths and fixed command templates.
- **Human authority:** approval gates model decisions that must remain with the Engineering Manager.

## What V0 actually does

The included objective asks the organization to implement `sum(a, b)` in a sample TypeScript project. Each run:

1. loads four declarative agent definitions and a feature workflow;
2. creates a durable objective and validated task graph;
3. copies the sample into a run-local workspace and makes a baseline Git commit;
4. asks the Developer through `MockProvider` to request a neutral file-write tool call;
5. asks the Tester to run a pre-approved Node test command;
6. asks the Reviewer to inspect Git status, the real Git diff, and the implementation file;
7. lets the Chief Engineer accept only when verification passed, review approved, evidence receipts exist, artifacts pass hash verification, and every acceptance criterion is covered;
8. persists a final report, ledger snapshot, and one journal entry per meaningful action.

The Chief Engineer's decomposition is deterministic in V0. It is an honest workflow coordinator and a replaceable seam, not a claim of autonomous engineering management.

## Architecture

The pnpm workspace has five packages:

| Package | Responsibility |
| --- | --- |
| `@agent-org/core` | Provider-free schemas, state transitions, authorization, evidence guards, capability model, approval gates, and ports |
| `@agent-org/providers` | Deterministic `MockProvider` and real `OpenAIProvider` adapter |
| `@agent-org/tools` | Permission-enforcing filesystem, fixed-command, Git tools, receipt generation, and workspace staging |
| `@agent-org/runtime` | Provider-neutral execution loop, Chief Engineer workflow, artifacts, configuration, and filesystem blackboard |
| `@agent-org/cli` | Composition root and inspection commands |

The dependency direction is enforced by tests: `core <- providers`, `core <- tools`, `core <- runtime`, with the CLI importing and injecting all concrete implementations.

See [architecture](docs/architecture.md), [provider model](docs/provider-model.md), and [security model](docs/security-model.md).

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer
- Git available on `PATH`

## Install and verify

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Ordinary tests are deterministic and never call a paid model API.

## Run the demonstration

```bash
pnpm agent-org run examples/simple-feature/objective.yaml
```

The command prints a run ID and the paths to the run directory, staged workspace, and final report. Inspect the latest run with:

```bash
pnpm agent-org status
pnpm agent-org tasks
pnpm agent-org reviews
pnpm agent-org events
pnpm agent-org inspect <TASK_ID>
```

Every inspection command accepts `--run <RUN_ID>`. `decisions` is also implemented; the V0 demo produces an empty list because it does not encounter an architectural decision.

Run state is stored under `.agent-org/state/runs/<RUN_ID>/`:

```text
ledger.json       derived current-state snapshot
events.jsonl      authoritative append-only transaction/event journal
artifacts/        immutable content-hashed reports
workspace/        run-local Git working tree
```

If a snapshot is absent or stale, it is repaired from the journal. Revision gaps or state-hash mismatches fail closed as integrity errors.

## Providers

`MockProvider` executes the demonstration deterministically through the same neutral tool-call protocol used by real providers.

`OpenAIProvider` maps neutral sessions, tool calls, structured output, and usage into the OpenAI Responses API. The CLI loads `.env.local` when `--provider openai` is selected:

```bash
pnpm agent-org run examples/simple-feature/objective.yaml --provider openai
```

This is an optional live run that consumes API usage. The orchestration and ordinary tests do not require an API key. A separately gated live adapter smoke test is available by setting `OPENAI_LIVE_TEST=1` while making `OPENAI_API_KEY` available to the process.

V0 validates provider capabilities before creating a session. It does not yet perform automatic provider routing or require provider diversity.

## Tools and MCP

Providers never execute local effects directly. They request neutral tool calls; the runtime sends those calls through a registry that checks role permissions and records receipts.

V0 tools are `filesystem.read`, `filesystem.write`, `filesystem.list`, `shell.execute`, `git.status`, and `git.diff`. Shell execution accepts a command-template ID—not an arbitrary shell string. The sample test template has a fixed executable, argument vector, working directory, timeout, bounded output, and scrubbed environment.

MCP belongs below the same tool abstraction as a future tool backend. Adding MCP should not change agent definitions, task state, or provider adapters.

## Roadmap

The smallest valuable V1 is deterministic multi-task decomposition with dependency scheduling and a human-interactive approval command. Later milestones can add:

- pluggable decomposition policies and richer Chief Engineer decision records;
- more provider adapters and risk-based provider diversity;
- isolated execution for untrusted code;
- MCP-backed GitHub, issue tracker, browser, database, and CI tools;
- resumable rework loops and explicit human CLI approval/denial;
- cost policy, routing, and richer observability.

V0 intentionally does not include distributed queues, services, databases, vector stores, deployment automation, merges, or a general autonomous swarm.

## License

MIT. See [LICENSE](LICENSE).
