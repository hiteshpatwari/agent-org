import { z } from "zod";

export const RoleSchema = z.enum([
  "ENGINEERING_MANAGER",
  "CHIEF_ENGINEER",
  "DEVELOPER",
  "TESTER",
  "REVIEWER",
]);
export type Role = z.infer<typeof RoleSchema>;

export const AuthorityActionSchema = z.enum([
  "CREATE_TASK",
  "ASSIGN_TASK",
  "CLAIM_TASK",
  "SUBMIT_RESULT",
  "REQUEST_HELP",
  "REQUEST_REVIEW",
  "START_VERIFICATION",
  "SUBMIT_VERIFICATION",
  "PASS_VERIFICATION",
  "FAIL_VERIFICATION",
  "START_REVIEW",
  "APPROVE",
  "REQUEST_CHANGES",
  "BLOCK",
  "FLAG_RISK",
  "REOPEN_TASK",
  "BLOCK_TASK",
  "ACCEPT_TASK",
  "REJECT_TASK",
  "CANCEL_TASK",
  "ESCALATE",
  "COMPLETE_OBJECTIVE",
]);
export type AuthorityAction = z.infer<typeof AuthorityActionSchema>;

export const RiskSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type Risk = z.infer<typeof RiskSchema>;

export const RequirementSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: RoleSchema.exclude(["ENGINEERING_MANAGER"]),
  mission: z.string().min(1),
  responsibilities: z.array(z.string().min(1)).min(1),
  may: z.array(z.string().min(1)).default([]),
  may_not: z.array(z.string().min(1)).default([]),
  required_outputs: z.array(z.string().min(1)).min(1),
  providerPreference: z.string().min(1).optional(),
  modelPreference: z.string().min(1).optional(),
  permissions: z.object({
    actions: z.array(AuthorityActionSchema),
    tools: z.array(z.string().min(1)),
  }),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const ObjectiveInputSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  risk: RiskSchema.default("MEDIUM"),
  workspaceTemplate: z.string().min(1),
  requirements: z.array(RequirementSchema).min(1),
  acceptanceCriteria: z.array(RequirementSchema).min(1),
  contextFiles: z.array(z.string().min(1)).default([]),
  verificationCommandIds: z.array(z.string().min(1)).default([]),
});
export type ObjectiveInput = z.infer<typeof ObjectiveInputSchema>;

export const ObjectiveStatusSchema = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type ObjectiveStatus = z.infer<typeof ObjectiveStatusSchema>;

export const ObjectiveSchema = ObjectiveInputSchema.required({ id: true }).extend({
  status: ObjectiveStatusSchema,
  taskIds: z.array(z.string().min(1)),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type Objective = z.infer<typeof ObjectiveSchema>;

export const TaskStatusSchema = z.enum([
  "PENDING",
  "READY",
  "IN_PROGRESS",
  "VERIFICATION_REQUIRED",
  "VERIFYING",
  "REVIEW_REQUIRED",
  "REVIEWING",
  "ACCEPTANCE_REQUIRED",
  "CHANGES_REQUESTED",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  objectiveId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  status: TaskStatusSchema,
  createdBy: z.string().min(1),
  dependencies: z.array(z.string().min(1)),
  requirements: z.array(RequirementSchema),
  acceptanceCriteria: z.array(RequirementSchema),
  risk: RiskSchema,
  implementerId: z.string().min(1).optional(),
  verifierId: z.string().min(1).optional(),
  reviewerId: z.string().min(1).optional(),
  resultId: z.string().min(1).optional(),
  verificationId: z.string().min(1).optional(),
  reviewId: z.string().min(1).optional(),
  artifactIds: z.array(z.string().min(1)),
  blockers: z.array(z.string().min(1)),
  reworkCount: z.number().int().nonnegative(),
  iteration: z.number().int().nonnegative().optional(),
  maxRework: z.number().int().nonnegative().optional(),
  workspaceStateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  verificationCommandIds: z.array(z.string().min(1)).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ActorPrincipalSchema = z.object({
  runId: z.string().min(1),
  objectiveId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  agentId: z.string().min(1),
  role: RoleSchema,
  iteration: z.number().int().nonnegative().optional(),
});
export type ActorPrincipal = z.infer<typeof ActorPrincipalSchema>;

export const WorkerStatusSchema = z.enum(["SUCCEEDED", "FAILED", "BLOCKED"]);

export const WorkerPayloadSchema = z
  .object({
    status: WorkerStatusSchema,
    summary: z.string().min(1),
    filesChanged: z.array(z.string()).default([]),
    commandsExecuted: z.array(z.string()).default([]),
    evidenceReceiptIds: z.array(z.string().min(1)).min(1),
    assumptions: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    questions: z.array(z.string()).default([]),
    artifacts: z.array(z.string()).default([]),
    blockers: z.array(z.string()).default([]),
    requestedNextAction: z.enum(["VERIFY", "REWORK", "BLOCK", "ESCALATE"]).default("VERIFY"),
  })
  .strict();
export type WorkerPayload = z.infer<typeof WorkerPayloadSchema>;

export const TaskResultSchema = WorkerPayloadSchema.extend({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  role: RoleSchema,
  agentRunId: z.string().min(1).optional(),
  iteration: z.number().int().nonnegative().optional(),
  workspaceStateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.string().datetime(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const TestRecordSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["PASSED", "FAILED", "SKIPPED"]),
  details: z.string().nullable().default(null),
});
export type TestRecord = z.infer<typeof TestRecordSchema>;

export const VerificationPayloadSchema = z
  .object({
    decision: z.enum(["PASS", "FAIL", "BLOCK"]),
    summary: z.string().min(1),
    tests: z.array(TestRecordSchema).min(1),
    requirementsChecked: z.array(z.string().min(1)).min(1),
    evidenceReceiptIds: z.array(z.string().min(1)).min(1),
    risks: z.array(z.string()).default([]),
    blockers: z.array(z.string()).default([]),
    requestedNextAction: z.enum(["REVIEW", "REWORK", "BLOCK", "ESCALATE"]).default("REVIEW"),
  })
  .strict();
export type VerificationPayload = z.infer<typeof VerificationPayloadSchema>;

export const VerificationSchema = VerificationPayloadSchema.extend({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  testerId: z.string().min(1),
  agentRunId: z.string().min(1).optional(),
  iteration: z.number().int().nonnegative().optional(),
  workspaceStateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.string().datetime(),
});
export type Verification = z.infer<typeof VerificationSchema>;

export const ReviewFindingSchema = z.object({
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewPayloadSchema = z
  .object({
    decision: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCK"]),
    summary: z.string().min(1),
    findings: z.array(ReviewFindingSchema),
    requirementsChecked: z.array(z.string().min(1)).min(1),
    evidenceReceiptIds: z.array(z.string().min(1)).min(1),
    unresolvedRisks: z.array(z.string()).default([]),
    blockers: z.array(z.string()).default([]),
    requestedNextAction: z.enum(["ACCEPT", "REWORK", "BLOCK", "ESCALATE"]).default("ACCEPT"),
  })
  .strict();
export type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;

export const ReviewSchema = ReviewPayloadSchema.extend({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  reviewerId: z.string().min(1),
  agentRunId: z.string().min(1).optional(),
  iteration: z.number().int().nonnegative().optional(),
  workspaceStateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.string().datetime(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const ExecutionReceiptSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  output: z.unknown(),
  status: z.enum(["SUCCEEDED", "FAILED"]),
  cwd: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  outputTruncated: z.boolean(),
  contentHashes: z.record(z.string(), z.string()).default({}),
  iteration: z.number().int().nonnegative().optional(),
  workspaceStateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  type: z.enum([
    "IMPLEMENTATION_REPORT",
    "TEST_REPORT",
    "REVIEW_REPORT",
    "DIFF",
    "DECISION",
    "FINAL_REPORT",
    "INVESTIGATION",
  ]),
  title: z.string().min(1),
  mediaType: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
  agentRunId: z.string().min(1).optional(),
  iteration: z.number().int().nonnegative().optional(),
  workspaceStateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const DecisionSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  title: z.string().min(1),
  context: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  evidence: z.array(z.string()),
  status: z.enum(["PROPOSED", "ACCEPTED", "SUPERSEDED", "REJECTED"]),
  decidedBy: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  action: z.string().min(1),
  reason: z.string().min(1),
  risk: RiskSchema,
  status: z.enum(["PENDING", "APPROVED", "DENIED"]),
  requestedBy: z.string().min(1),
  decidedBy: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ProviderErrorCodeSchema = z.enum([
  "AUTHENTICATION",
  "QUOTA_EXHAUSTED",
  "RATE_LIMIT",
  "TIMEOUT",
  "NETWORK",
  "MODEL_ACCESS",
  "INVALID_RESPONSE",
  "CANCELLED",
  "UNKNOWN",
]);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;

export const ProviderErrorRecordSchema = z.object({
  code: ProviderErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  providerId: z.string().min(1),
  statusCode: z.number().int().optional(),
});
export type ProviderErrorRecord = z.infer<typeof ProviderErrorRecordSchema>;

export const ProviderAttemptSchema = z.object({
  number: z.number().int().positive(),
  turn: z.number().int().positive(),
  status: z.enum(["RUNNING", "SUCCEEDED", "FAILED"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  error: ProviderErrorRecordSchema.optional(),
});
export type ProviderAttempt = z.infer<typeof ProviderAttemptSchema>;

export const AgentRunSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  role: RoleSchema,
  providerId: z.string().min(1),
  model: z.string().optional(),
  status: z.enum(["RUNNING", "SUCCEEDED", "FAILED"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  usage: UsageSchema.default({}),
  receiptIds: z.array(z.string().min(1)),
  error: z.string().optional(),
  iteration: z.number().int().nonnegative().optional(),
  workspaceStateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  attempts: z.array(ProviderAttemptSchema).optional(),
  retryCount: z.number().int().nonnegative().optional(),
  providerErrors: z.array(ProviderErrorRecordSchema).optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const DomainEventTypeSchema = z.enum([
  "OBJECTIVE_CREATED",
  "OBJECTIVE_COMPLETED",
  "TASK_CREATED",
  "TASK_READY",
  "TASK_ASSIGNED",
  "AGENT_STARTED",
  "TOOL_EXECUTED",
  "AGENT_COMPLETED",
  "IMPLEMENTATION_SUBMITTED",
  "TEST_STARTED",
  "TEST_COMPLETED",
  "REVIEW_REQUESTED",
  "REVIEW_STARTED",
  "REVIEW_COMPLETED",
  "CHANGES_REQUESTED",
  "TASK_BLOCKED",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "TASK_CANCELLED",
  "DECISION_RECORDED",
  "HUMAN_APPROVAL_REQUIRED",
  "HUMAN_APPROVAL_RESOLVED",
  "ARTIFACT_CREATED",
  "PROVIDER_ATTEMPTED",
  "PROVIDER_RETRY_SCHEDULED",
  "PROVIDER_FAILED",
  "RUN_INTERRUPTED",
  "RUN_RESUMED",
  "WORKSPACE_STAGED",
  "REWORK_STARTED",
  "REWORK_EXHAUSTED",
]);
export type DomainEventType = z.infer<typeof DomainEventTypeSchema>;

export const DomainEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  type: DomainEventTypeSchema,
  actorId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  timestamp: z.string().datetime(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const LedgerSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  objective: ObjectiveSchema,
  tasks: z.array(TaskSchema),
  results: z.array(TaskResultSchema),
  verifications: z.array(VerificationSchema),
  reviews: z.array(ReviewSchema),
  receipts: z.array(ExecutionReceiptSchema),
  artifacts: z.array(ArtifactSchema),
  decisions: z.array(DecisionSchema),
  approvals: z.array(ApprovalRequestSchema),
  agentRuns: z.array(AgentRunSchema),
  lifecycle: z.enum(["INITIALIZING", "RUNNING", "INTERRUPTED", "COMPLETED", "FAILED"]).optional(),
  workspaceStateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  preparedWorkspace: z.object({
    sourceType: z.enum(["template", "local-git"]),
    path: z.string().min(1),
    projectRoot: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  }).optional(),
  configurationSnapshot: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Ledger = z.infer<typeof LedgerSchema>;

export const ChiefPlanPayloadSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    requirementIds: z.array(z.string().min(1)).min(1),
    acceptanceCriterionIds: z.array(z.string().min(1)).min(1),
    dependencies: z.array(z.string().min(1)),
    assumptions: z.array(z.string()),
    risks: z.array(z.string()),
    blockers: z.array(z.string()),
    requestedNextAction: z.literal("ASSIGN"),
  })
  .strict();
export type ChiefPlanPayload = z.infer<typeof ChiefPlanPayloadSchema>;

export const WorkspaceFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
});
export const WorkspaceStateSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(WorkspaceFileSchema),
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

export const PreparedWorkspaceSchema = z.object({
  sourceType: z.enum(["template", "local-git"]),
  path: z.string().min(1),
  projectRoot: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});
export type PreparedWorkspace = z.infer<typeof PreparedWorkspaceSchema>;

export const JournalEntrySchema = z.object({
  revision: z.number().int().positive(),
  previousRevision: z.number().int().nonnegative(),
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  event: DomainEventSchema,
  state: LedgerSchema,
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
