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

V1.1 can use either deterministic `MockProvider` execution or the OpenAI Responses API. Both paths use the same core task state, authorization, tool, receipt, artifact, recovery, and evidence contracts.

## Quick start

Build and link the CLI once from this repository:

```bash
pnpm install
pnpm build
npm link
```

Then invoke Agent Org from any clean Node/TypeScript Git repository:

```bash
cd my-project
agent-org "Add CSV export" --provider openai
```

The shorthand is equivalent to:

```bash
agent-org run "Add CSV export" --provider openai
```

Agent Org resolves the Git root even when invoked from a nested directory. It rejects a dirty working tree, creates an isolated `agent-org/<run-id>` branch and linked worktree, performs all agent writes there, and never merges automatically. The final result reports the branch, worktree, changed files, tests, and review evidence for human inspection.

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

## Requirements and contributor verification

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
pnpm agent-org run --objective-file examples/simple-feature/objective.yaml --provider mock
```

The V1 fixture is a deliberately defective TypeScript order-pricing library. It requires repository inspection, changes to two production modules and a regression test, execution of a fixed Node test command, diff review, and evidence-backed acceptance:

```bash
pnpm agent-org run examples/real-bug-fix/objective.yaml --provider mock
```

The eval suite asserts outcomes and chronology rather than generated wording. It covers a simple feature, realistic bug fix, reviewer rejection followed by rework, and repeated failing verification that exhausts the rework policy.

## Configuration

Agent Org uses built-in organization defaults when no configuration exists. Global configuration belongs under `~/.agent-org/`; set `AGENT_ORG_HOME` to use another location. A global installation may provide `organization.yaml`, `agents/`, workflows/policies, and optional `project-defaults.yaml`. Never store API keys in these YAML files.

A project may optionally define `.agent-org.yaml`:

```yaml
verification:
  test: test
  lint: lint
  typecheck: typecheck
  build: build
context:
  include:
    - PRODUCT.md
    - docs/architecture.md
risk:
  default: MEDIUM
```

Precedence is CLI options, project `.agent-org.yaml`, global configuration, then built-in defaults. Project mode currently supports Node/TypeScript repositories. Package-manager selection prefers the `packageManager` field, then `pnpm-lock.yaml`, `yarn.lock`, and `package-lock.json`. Existing `test`, `lint`, `typecheck`, and `build` scripts are exposed only through the fixed IDs `project.test`, `project.lint`, `project.typecheck`, and `project.build`; models cannot supply shell command strings.

Root `AGENTS.md`, `README.md`, `PRODUCT.md`, `package.json`, and `tsconfig.json` are considered as bounded project context when present. Configured additions are allowed, but `.env*`, credentials, registry configuration, private keys, and `.git` internals are excluded. Project instructions are guidance and cannot override organization security, authority, or evidence policy.

## OpenAI configuration

Provider policy comes from global or built-in organization configuration; each agent selects a provider/model through its declarative definition. CLI flags can override all roles for one run:

```bash
agent-org "Implement the requested feature" --provider openai --model gpt-5.4-mini
```

To configure credentials:

1. [Create an OpenAI API key](https://platform.openai.com/api-keys). OpenAI's [API quickstart](https://developers.openai.com/api/docs/quickstart) also explains how to create and export the key.
2. Copy the secret when it is shown, then add it to an ignored `.env.local` file at the repository root:

   ```dotenv
   OPENAI_API_KEY=your_api_key_here
   ```

   Alternatively, set it for future PowerShell sessions as shown in the official quickstart:

   ```powershell
   setx OPENAI_API_KEY "your_api_key_here"
   ```

3. Never commit the key or `.env.local`. The CLI loads the credential only for OpenAI execution; query commands do not load provider credentials.

The adapter uses strict structured output and function tools, normalizes provider failures, disables hidden SDK retries, captures usage/model metadata, and accepts an abort signal. Automatic retries stop once a local effect has occurred; malformed final output uses a corrective turn in the same session.

## Objective-file compatibility

Prompt input is the normal developer workflow. Objective YAML remains supported for deterministic fixtures, evals, and advanced use:

```bash
pnpm agent-org run --objective-file examples/real-bug-fix/objective.yaml --provider mock
```

The original positional file form remains backwards-compatible when the single argument is an existing `.yaml` or `.yml` file. Use `--objective-file` when intent could otherwise be ambiguous.

## Run inspection and recovery

```bash
agent-org runs
agent-org status --run <RUN_ID>
agent-org tasks --run <RUN_ID>
agent-org inspect <TASK_ID> --run <RUN_ID>
agent-org events --run <RUN_ID>
agent-org reviews --run <RUN_ID>
agent-org resume <RUN_ID> --provider openai --model gpt-5.4-mini
```

Project-mode data is stored outside the target repository under `~/.agent-org/projects/<project-id>/runs/<RUN_ID>/` (or the corresponding `AGENT_ORG_HOME`). The project ID is a deterministic hash of the canonical Git root. Legacy objective-file runs retain `.agent-org/state/runs/<RUN_ID>/` for compatibility.

```text
ledger.json       derived current-state snapshot
events.jsonl      authoritative append-only revision/hash journal
artifacts/        immutable content-hashed, redacted reports
workspace/        isolated linked Git worktree or template repository
```

Project-mode workspace staging uses Git worktrees and refuses uncommitted tracked or untracked changes. Template mode still copies the configured fixture, creates a baseline Git commit, and atomically renames it into the run. A single-writer lock rejects concurrent resume. V0/V1 journals remain readable: raw stored state is hash-verified before additive defaults are applied.

## Tools and security boundary

Available neutral tools are `filesystem.read`, `filesystem.write`, `filesystem.list`, `repository.search`, `shell.execute`, `git.status`, and `git.diff`. Roles receive explicit subsets. Reviewers cannot write; testers cannot write production code. Shell calls accept an administrator-defined command ID, never a model-authored command line.

Paths are resolved under the run workspace; symlink/junction escape and sensitive paths such as `.env*`, `.git`, private keys, and package credentials are denied. Persisted write receipts contain content hashes and sizes instead of full source. Common secret shapes are redacted from errors, outputs, inputs, and artifacts.

These are application controls, not an OS sandbox. An allowed native command still has the current user's operating-system authority. Arbitrary untrusted repositories require stronger process isolation.

## Intentionally unsupported in V1.1

- distributed queues or services;
- container/VM sandboxing;
- arbitrary shell commands;
- automatic merges, deployments, or infrastructure mutation;
- additional roles or a dashboard;
- Anthropic/Cursor/Copilot adapters;
- mandatory cross-provider review for high-risk tasks.
- automatic discovery for non-Node language ecosystems.

The next smallest step is a second provider adapter plus a core risk policy that can require implementation and review to use different provider instances.

## License

MIT. See [LICENSE](LICENSE).
