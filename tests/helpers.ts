import type {
  ActorPrincipal,
  AgentDefinition,
  ExecutionReceipt,
  Ledger,
  Objective,
  Review,
  Task,
  TaskResult,
  Verification,
} from "@agent-org/core";

export const timestamp = "2026-08-25T00:00:00.000Z";

export function objective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: "OBJ-1",
    title: "Implement sum",
    description: "Implement sum(a, b).",
    risk: "LOW",
    workspaceTemplate: "example",
    requirements: [{ id: "REQ-1", text: "Export sum." }],
    acceptanceCriteria: [
      { id: "AC-TEST", text: "Tests pass." },
      { id: "AC-DIFF", text: "Diff is scoped." },
    ],
    contextFiles: [],
    verificationCommandIds: [],
    status: "IN_PROGRESS",
    taskIds: ["TASK-1"],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "TASK-1",
    objectiveId: "OBJ-1",
    title: "Implement sum",
    description: "Implement sum(a, b).",
    status: "PENDING",
    createdBy: "chief",
    dependencies: [],
    requirements: [{ id: "REQ-1", text: "Export sum." }],
    acceptanceCriteria: [
      { id: "AC-TEST", text: "Tests pass." },
      { id: "AC-DIFF", text: "Diff is scoped." },
    ],
    risk: "LOW",
    artifactIds: [],
    blockers: [],
    reworkCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function principal(
  role: ActorPrincipal["role"],
  agentId = role.toLowerCase(),
): ActorPrincipal {
  return { runId: "RUN-1", objectiveId: "OBJ-1", taskId: "TASK-1", agentId, role };
}

export function agent(
  role: AgentDefinition["role"],
  id = role.toLowerCase(),
  actions: AgentDefinition["permissions"]["actions"] = [],
  tools: string[] = [],
): AgentDefinition {
  return {
    id,
    name: role,
    role,
    mission: `Perform ${role} work.`,
    responsibilities: ["work"],
    may: [],
    may_not: [],
    required_outputs: ["summary"],
    permissions: { actions, tools },
  };
}

export function implementationResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    id: "RESULT-1",
    runId: "RUN-1",
    taskId: "TASK-1",
    agentId: "developer",
    role: "DEVELOPER",
    status: "SUCCEEDED",
    summary: "Implemented sum.",
    filesChanged: ["src/sum.ts"],
    commandsExecuted: [],
    evidenceReceiptIds: ["RCT-WRITE"],
    assumptions: [],
    risks: [],
    questions: [],
    artifacts: [],
    blockers: [],
    requestedNextAction: "VERIFY",
    createdAt: timestamp,
    ...overrides,
  };
}

export function receipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    id: "RCT-TEST",
    runId: "RUN-1",
    taskId: "TASK-1",
    agentId: "tester",
    toolName: "shell.execute",
    input: { commandId: "test" },
    output: { stdout: "ok", stderr: "", exitCode: 0 },
    status: "SUCCEEDED",
    cwd: "C:\\workspace",
    exitCode: 0,
    startedAt: timestamp,
    completedAt: timestamp,
    outputTruncated: false,
    contentHashes: {},
    ...overrides,
  };
}

export function verification(overrides: Partial<Verification> = {}): Verification {
  return {
    id: "VERIFY-1",
    runId: "RUN-1",
    taskId: "TASK-1",
    testerId: "tester",
    decision: "PASS",
    summary: "Tests pass.",
    tests: [{ name: "test", status: "PASSED", details: null }],
    requirementsChecked: ["AC-TEST", "AC-DIFF"],
    evidenceReceiptIds: ["RCT-TEST"],
    producedEvidenceReceiptIds: ["RCT-TEST"],
    observedEvidenceReceiptIds: [],
    risks: [],
    blockers: [],
    requestedNextAction: "REVIEW",
    createdAt: timestamp,
    ...overrides,
  };
}

export function review(overrides: Partial<Review> = {}): Review {
  const base: Review = {
    id: "REVIEW-1",
    runId: "RUN-1",
    taskId: "TASK-1",
    reviewerId: "reviewer",
    decision: "APPROVE",
    summary: "Approved.",
    findings: [],
    requirementsChecked: ["AC-TEST", "AC-DIFF"],
    evidenceReceiptIds: ["RCT-DIFF"],
    producedEvidenceReceiptIds: ["RCT-DIFF"],
    observedEvidenceReceiptIds: [],
    unresolvedRisks: [],
    blockers: [],
    requestedNextAction: "ACCEPT",
    createdAt: timestamp,
    ...overrides,
  };
  if ("evidenceReceiptIds" in overrides && !("producedEvidenceReceiptIds" in overrides)) base.producedEvidenceReceiptIds = base.evidenceReceiptIds;
  return base;
}

export function ledger(overrides: Partial<Ledger> = {}): Ledger {
  return {
    version: 1,
    runId: "RUN-1",
    revision: 0,
    objective: objective(),
    tasks: [],
    results: [],
    verifications: [],
    reviews: [],
    receipts: [],
    artifacts: [],
    decisions: [],
    approvals: [],
    agentRuns: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}
