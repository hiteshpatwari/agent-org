# Architecture

## Organizational model

```mermaid
flowchart TD
    H[Human Engineering Manager] --> C[Chief Engineer workflow coordinator]
    C --> D[Developer]
    D --> T[Tester]
    T --> R[Reviewer]
    R --> C
    C -->|accept or reject| L[(Durable blackboard)]
    D --> L
    T --> L
    R --> L
    L --> J[Append-only event journal]
    L --> A[Hashed artifacts and receipts]
    L --> G[Run-local Git workspace]
```

The human supplies an objective. V0's Chief Engineer deterministically creates one task, assigns it, coordinates verification and review, enforces acceptance guards, completes the objective, and writes a final report. The decomposition seam produces a validated task graph; the included scenario has one task with no dependencies.

Workers do not need unconstrained peer-to-peer conversation. They read a scoped execution context and return structured payloads to shared state. The runtime—not the provider—stamps run, objective, task, agent, and role provenance.

## Execution architecture

```mermaid
flowchart LR
    CLI[CLI composition root] --> RT[Provider-neutral runtime]
    CLI --> PA[Provider adapter]
    CLI --> TR[Tool registry]
    CLI --> WS[Workspace manager]
    RT --> CP[Core ports and policies]
    PA --> CP
    TR --> CP
    WS --> CP
    PA --> M[MockProvider]
    PA --> O[OpenAIProvider]
    TR --> N[Native local tools]
    TR -. future .-> MCP[MCP tool backend]
    MCP -.-> EXT[GitHub / Jira / DB / Browser / CI]
```

`@agent-org/runtime` has no dependency on `@agent-org/providers`, `@agent-org/tools`, or a provider SDK. The CLI is the only composition root and injects implementations through core interfaces.

## Neutral provider loop

```mermaid
sequenceDiagram
    participant R as Runtime
    participant P as AgentProvider
    participant T as ToolRegistry
    participant B as Blackboard

    R->>P: createSession(trusted principal, role)
    R->>P: execute(context, neutral tools, output schema)
    P-->>R: neutral tool calls
    loop each authorized call
        R->>T: execute(principal, workspace, call)
        T-->>R: result + immutable receipt
        R->>B: commit receipt and TOOL_EXECUTED event
    end
    R->>P: execute(tool results with receipt IDs)
    P-->>R: structured worker payload
    R->>R: runtime validation and provenance stamping
    R->>B: commit result, artifact, and state transition
    R->>P: closeSession
```

Each execution has maximum turns, maximum tool calls, and a duration limit. Provider capabilities are checked before session creation.

## Task lifecycle

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> READY: dependencies satisfied
    READY --> IN_PROGRESS: assigned Developer claims
    IN_PROGRESS --> VERIFICATION_REQUIRED: implementation succeeds
    IN_PROGRESS --> FAILED: implementation fails
    VERIFICATION_REQUIRED --> VERIFYING: Chief assigns Tester
    VERIFYING --> REVIEW_REQUIRED: real test receipt passes
    VERIFYING --> CHANGES_REQUESTED: verification fails
    REVIEW_REQUIRED --> REVIEWING: Chief assigns independent Reviewer
    REVIEWING --> ACCEPTANCE_REQUIRED: evidence-backed approval
    REVIEWING --> CHANGES_REQUESTED: changes requested
    REVIEWING --> BLOCKED: review blocks
    ACCEPTANCE_REQUIRED --> COMPLETED: Chief acceptance guards pass
    ACCEPTANCE_REQUIRED --> CHANGES_REQUESTED: Chief rejects
    CHANGES_REQUESTED --> READY: Chief reopens
    FAILED --> READY: Chief reopens
    BLOCKED --> READY: Chief reopens
    PENDING --> CANCELLED
    READY --> CANCELLED
    IN_PROGRESS --> CANCELLED
```

One reducer is the task mutation path. Guards validate trusted actor scope, role authority, immutable assignments, structured result provenance, independent verification/review, real receipt ownership, Git evidence, criterion coverage, and valid state transitions.

Objectives have their own lifecycle. Only the Chief Engineer can complete one, every referenced task must be `COMPLETED`, and no human approval may remain pending.

## Blackboard and durability

The filesystem blackboard stores an authoritative `events.jsonl` journal. Each line contains:

- a monotonic revision and previous revision;
- one domain event;
- the resulting ledger state;
- a SHA-256 hash of that state.

`ledger.json` is an atomically replaced cache of the latest valid journal state. Loading validates every revision and hash, then repairs a missing or stale snapshot. This is a small write-ahead journal, not a general event-sourcing framework.

Reports are immutable content-addressed artifacts. Tool receipts record trusted provenance, input, bounded output, timestamps, status, working directory, exit code, and file hashes where applicable. Agent-run records capture provider, model, duration, usage, receipt IDs, status, and errors.

## Verification and acceptance

The tester's `PASS` is insufficient by itself. The domain requires a successful `shell.execute` receipt owned by the assigned tester. Likewise, reviewer `APPROVE` requires a successful, non-empty `git.diff` receipt owned by an agent other than the implementer. Final acceptance checks that both records belong to the task, reference known receipts, and cover every acceptance criterion.
