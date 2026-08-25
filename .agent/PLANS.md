# Execution Plans

Substantial features, cross-package refactors, storage migrations, provider changes, and security-sensitive work require a durable ExecPlan before implementation begins.

An ExecPlan is a living engineering record. Store it under `.agent/plans/`, keep it understandable without chat history, and update it whenever implementation changes the design.

Every ExecPlan must include:

- purpose and user-visible outcome;
- scope and explicit non-goals;
- assumptions and constraints;
- current repository state;
- architecture and package-boundary decisions;
- domain invariants and security boundaries;
- milestones with observable completion criteria;
- test and verification commands;
- demo or acceptance procedure;
- risks, recovery strategy, and unresolved decisions;
- a progress log and a final implementation retrospective.

Plans should describe behavior, not merely filenames. Record discoveries and changes of direction as work proceeds. A future contributor should be able to resume from the plan alone.
