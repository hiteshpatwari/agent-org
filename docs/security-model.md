# V1 security model

## Trust boundaries

Core policy, runtime-owned principals/provenance, journal integrity checks, configured tool implementations, and the human Engineering Manager are trusted control-plane components. Provider output and all repository content are untrusted data even after structural validation.

The provider cannot expand its role, tool allowlist, command catalog, workspace path, or organizational authority. Repository text is labeled untrusted provider input; it is not placed in privileged policy instructions.

## Identity, independence, and semantic validation

Runtime stamps run/objective/task/agent/run/iteration/workspace provenance. Domain guards reject implementer-as-tester, implementer-as-reviewer, evidence owned by another actor, stale-iteration evidence, mismatched workspace state, missing required command receipts, incomplete criterion coverage, and invalid transitions.

Schema-valid JSON is not automatically trusted. Success with blockers, PASS with failed tests, APPROVE with blocking findings, and inconsistent requested actions fail semantic validation.

## Tool boundary

Filesystem operations resolve beneath a real run-workspace root and reject absolute paths, traversal, symlink/junction escape, and sensitive path segments including `.env*`, `.git`, `.npmrc`, private-key filenames, and `.pem`/`.key` files. Repository search is literal, bounded by file size/result count, skips generated/sensitive directories, and redacts output.

`shell.execute` accepts one configured command ID. It invokes a fixed executable and argument vector with `shell: false`, a real fixed working directory, scrubbed environment, timeout, hidden Windows process, and bounded output. Git tools also use fixed arguments. Shipped catalogs contain no dangerous commands.

The generic approval record remains a durable organizational gate and pending approvals prevent completion. V1 does not claim that merely recording approval constrains an arbitrary native executable; a future dangerous command must check approved policy before effect execution.

## Secrets and persistence

API keys are environment-only. They are not added to configuration snapshots or prompts intentionally. Query commands do not load them.

Common API-key/token/private-key shapes are redacted at provider error normalization, tool receipt input/output, and artifact write boundaries. File-write receipts persist path, size, and content hash instead of full source content. Sensitive workspace files are inaccessible to agents. Prompts and raw provider responses are never persisted.

No pattern-based redactor is perfect. Operators must not place credentials in fixture source or allowed command output. V1 is not a general secret manager.

## Isolation and process risk

Each run uses its own Git workspace and canonical state manifest: copied baseline repositories for deterministic templates and linked worktrees for current-project mode. Atomic template staging prevents agents seeing a half-copied initial workspace. Reviewer and tester definitions have no write tool. A per-run writer lock prevents concurrent resume.

This is lightweight workspace isolation, not an OS sandbox. Allowed Node/Git/native processes still run with the Codex user's operating-system permissions and could access network or files outside the workspace through their own behavior. Use a container, VM, restricted account, filesystem ACLs, and network policy before running attacker-controlled repositories or commands.

## Integrity and recovery limits

The journal is revisioned and hash-validated; snapshots are derived and artifacts are content-addressed. This detects accidental/tampered individual records but is not externally signed or immutable against a user who can rewrite the entire repository and journal.

Native filesystem effects and journal commits are not transactional. A crash can leave an unreceipted partial file change. Resume preserves the workspace, records interruption, and reruns only the active durable stage, but V1 does not guarantee exactly-once effects.

## Remaining risks

- no container/VM sandbox, syscall policy, or network isolation;
- no CLI authentication or external signed audit store;
- no global API cost ceiling or interactive live-usage approval;
- no mandatory cross-provider review;
- no MCP trust policy;
- nondeterministic real-model behavior remains bounded, not eliminated.

## V1.1 current-project isolation

Project mode fails closed when tracked or untracked changes exist and never initializes, cleans, stages, commits, or merges the user's active working tree. A clean committed `HEAD` is attached as a separate Git worktree on an `agent-org/<run-id>` branch; agent filesystem tools remain scoped beneath that worktree.

Node verification discovery recognizes only configured package scripts mapped to `project.test`, `project.lint`, `project.typecheck`, and `project.build`. Script names are validated and command templates are assembled by the trusted CLI. Providers receive command IDs rather than command strings. Package scripts still execute with the current user's operating-system authority, so this is not native-code sandboxing.

Root context discovery is allowlisted and bounded. `.env*`, Git internals, registry credentials, credential files, and private-key extensions are excluded even when project configuration requests them. `AGENTS.md` is untrusted project guidance subordinate to organization permissions, authority, evidence, approval, and redaction rules.
