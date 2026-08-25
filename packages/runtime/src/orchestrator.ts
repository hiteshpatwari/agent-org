import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AgentRunSchema,
  ReviewPayloadSchema,
  ReviewSchema,
  TaskResultSchema,
  VerificationPayloadSchema,
  VerificationSchema,
  WorkerPayloadSchema,
  authorize,
  completeObjective,
  transitionTask,
  validateTaskGraph,
  type ActorPrincipal,
  type AgentDefinition,
  type AgentProvider,
  type AgentRun,
  type Artifact,
  type Ledger,
  type Objective,
  type ObjectiveInput,
  type ProviderCapability,
  type Review,
  type Role,
  type Task,
  type ToolRegistryPort,
  type Verification,
  type WorkspaceManagerPort,
} from "@agent-org/core";

import { AgentExecutor } from "./agent-executor.js";
import { FileArtifactStore } from "./artifacts.js";
import type { BlackboardStore, EventInput } from "./storage.js";

const stringArray = { type: "array", items: { type: "string" } } as const;
const workerJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["SUCCEEDED", "FAILED", "BLOCKED"] },
    summary: { type: "string" },
    filesChanged: stringArray,
    commandsExecuted: stringArray,
    evidenceReceiptIds: stringArray,
    assumptions: stringArray,
    risks: stringArray,
    questions: stringArray,
    artifacts: stringArray,
  },
  required: [
    "status",
    "summary",
    "filesChanged",
    "commandsExecuted",
    "evidenceReceiptIds",
    "assumptions",
    "risks",
    "questions",
    "artifacts",
  ],
};

const verificationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["PASS", "FAIL", "BLOCK"] },
    summary: { type: "string" },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          status: { type: "string", enum: ["PASSED", "FAILED", "SKIPPED"] },
          details: { type: ["string", "null"] },
        },
        required: ["name", "status", "details"],
      },
    },
    requirementsChecked: stringArray,
    evidenceReceiptIds: stringArray,
    risks: stringArray,
  },
  required: ["decision", "summary", "tests", "requirementsChecked", "evidenceReceiptIds", "risks"],
};

const reviewJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "BLOCK"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] },
          summary: { type: "string" },
          evidence: stringArray,
        },
        required: ["severity", "summary", "evidence"],
      },
    },
    requirementsChecked: stringArray,
    evidenceReceiptIds: stringArray,
    unresolvedRisks: stringArray,
  },
  required: [
    "decision",
    "summary",
    "findings",
    "requirementsChecked",
    "evidenceReceiptIds",
    "unresolvedRisks",
  ],
};

export interface OrganizationRuntimeOptions {
  repositoryRoot: string;
  stateDirectory: string;
  agents: Map<Role, AgentDefinition>;
  requiredCapabilities: ProviderCapability[];
  provider: AgentProvider;
  tools: ToolRegistryPort;
  workspaceManager: WorkspaceManagerPort;
  blackboard: BlackboardStore;
}

export interface CompletedRun {
  runId: string;
  ledger: Ledger;
  runDirectory: string;
  workspaceDirectory: string;
  finalReport: Artifact;
}

function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function runId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  return `RUN-${stamp}-${randomUUID().slice(0, 8)}`;
}

function principal(
  run: string,
  objectiveId: string,
  agent: AgentDefinition,
  taskId?: string,
): ActorPrincipal {
  return {
    runId: run,
    objectiveId,
    ...(taskId ? { taskId } : {}),
    agentId: agent.id,
    role: agent.role,
  };
}

function replaceTask(ledger: Ledger, task: Task): Ledger {
  return { ...ledger, tasks: ledger.tasks.map((item) => (item.id === task.id ? task : item)) };
}

function replaceAgentRun(ledger: Ledger, run: AgentRun): Ledger {
  return {
    ...ledger,
    agentRuns: ledger.agentRuns.map((item) => (item.id === run.id ? run : item)),
  };
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[REDACTED]")
    .replace(/(OPENAI_API_KEY\s*[=:]\s*)\S+/giu, "$1[REDACTED]");
}

function createTask(objective: Objective, chief: AgentDefinition): Task {
  const now = new Date().toISOString();
  return {
    id: newId("TASK"),
    objectiveId: objective.id,
    title: objective.title,
    description: objective.description,
    status: "PENDING",
    createdBy: chief.id,
    dependencies: [],
    requirements: [...objective.requirements],
    acceptanceCriteria: [...objective.acceptanceCriteria],
    risk: objective.risk,
    artifactIds: [],
    blockers: [],
    reworkCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function createAgentRun(
  run: string,
  task: Task,
  agent: AgentDefinition,
  provider: AgentProvider,
): AgentRun {
  return AgentRunSchema.parse({
    id: newId("ARUN"),
    runId: run,
    taskId: task.id,
    agentId: agent.id,
    role: agent.role,
    providerId: provider.id,
    ...(agent.modelPreference ? { model: agent.modelPreference } : {}),
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    usage: {},
    receiptIds: [],
  });
}

function finalReportMarkdown(ledger: Ledger): string {
  const task = ledger.tasks[0];
  const verification = ledger.verifications[0];
  const review = ledger.reviews[0];
  return [
    `# Objective report: ${ledger.objective.title}`,
    "",
    `- Run: ${ledger.runId}`,
    `- Objective status: ${ledger.objective.status}`,
    `- Task status: ${task?.status ?? "missing"}`,
    `- Verification: ${verification?.decision ?? "missing"}`,
    `- Review: ${review?.decision ?? "missing"}`,
    `- Provider: ${ledger.agentRuns[0]?.providerId ?? "missing"}`,
    `- Tool receipts: ${ledger.receipts.length}`,
    "",
    "Completion was accepted only after a passing command receipt and an independent review with Git evidence.",
    "",
  ].join("\n");
}

export class OrganizationRuntime {
  private readonly artifacts: FileArtifactStore;
  private readonly executor: AgentExecutor;

  public constructor(private readonly options: OrganizationRuntimeOptions) {
    this.artifacts = new FileArtifactStore(options.blackboard);
    this.executor = new AgentExecutor(options.provider, options.tools);
  }

  private agent(role: Role): AgentDefinition {
    const agent = this.options.agents.get(role);
    if (!agent) throw new Error(`No configured agent for ${role}.`);
    return agent;
  }

  public async run(input: ObjectiveInput): Promise<CompletedRun> {
    const currentRunId = runId();
    const now = new Date().toISOString();
    const objective: Objective = {
      ...input,
      id: input.id ?? newId("OBJ"),
      status: "IN_PROGRESS",
      taskIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const chief = this.agent("CHIEF_ENGINEER");
    const developer = this.agent("DEVELOPER");
    const tester = this.agent("TESTER");
    const reviewer = this.agent("REVIEWER");
    const chiefObjectivePrincipal = principal(currentRunId, objective.id, chief);
    authorize(chiefObjectivePrincipal, chief, "CREATE_TASK");

    const initial: Ledger = {
      version: 1,
      runId: currentRunId,
      revision: 0,
      objective,
      tasks: [],
      results: [],
      verifications: [],
      reviews: [],
      receipts: [],
      artifacts: [],
      decisions: [],
      approvals: [],
      agentRuns: [],
      createdAt: now,
      updatedAt: now,
    };
    let ledger = await this.options.blackboard.createRun(initial, {
      type: "OBJECTIVE_CREATED",
      actorId: chief.id,
      data: { objectiveId: objective.id, title: objective.title },
    });
    const workspace = this.options.blackboard.workspaceDirectory(currentRunId);
    await this.options.workspaceManager.stage(
      path.resolve(this.options.repositoryRoot, objective.workspaceTemplate),
      workspace,
    );

    const commit = async (next: Ledger, event: EventInput): Promise<void> => {
      ledger = await this.options.blackboard.commit(currentRunId, ledger.revision, next, event);
    };

    let task = createTask(objective, chief);
    validateTaskGraph([task]);
    await commit(
      {
        ...ledger,
        objective: { ...ledger.objective, taskIds: [task.id], updatedAt: new Date().toISOString() },
        tasks: [task],
      },
      { type: "TASK_CREATED", actorId: chief.id, taskId: task.id, data: { title: task.title } },
    );

    const chiefTaskPrincipal = principal(currentRunId, objective.id, chief, task.id);
    task = transitionTask(task, { type: "MARK_READY", completedDependencyIds: [] }, chiefTaskPrincipal);
    await commit(replaceTask(ledger, task), {
      type: "TASK_READY",
      actorId: chief.id,
      taskId: task.id,
    });

    authorize(chiefTaskPrincipal, chief, "ASSIGN_TASK");
    task = transitionTask(task, { type: "ASSIGN_IMPLEMENTER", implementerId: developer.id }, chiefTaskPrincipal);
    await commit(replaceTask(ledger, task), {
      type: "TASK_ASSIGNED",
      actorId: chief.id,
      taskId: task.id,
      data: { assigneeId: developer.id, role: developer.role },
    });

    const developerPrincipal = principal(currentRunId, objective.id, developer, task.id);
    authorize(developerPrincipal, developer, "CLAIM_TASK");
    task = transitionTask(task, { type: "CLAIM_IMPLEMENTATION" }, developerPrincipal);
    const developerRun = createAgentRun(currentRunId, task, developer, this.options.provider);
    await commit(
      { ...replaceTask(ledger, task), agentRuns: [...ledger.agentRuns, developerRun] },
      { type: "AGENT_STARTED", actorId: developer.id, taskId: task.id, data: { role: developer.role } },
    );

    const executeAgent = async <T>(args: {
      agent: AgentDefinition;
      actor: ActorPrincipal;
      agentRun: AgentRun;
      prompt: string;
      outputSchema: Parameters<AgentExecutor["execute"]>[0]["outputSchema"];
      outputName: string;
      outputJsonSchema: Record<string, unknown>;
    }): Promise<T> => {
      try {
        const output = await this.executor.execute({
          principal: args.actor,
          agent: args.agent,
          workspacePath: workspace,
          prompt: args.prompt,
          context: {
            objective: ledger.objective,
            task,
            acceptanceCriteria: task.acceptanceCriteria,
          },
          requiredCapabilities: this.options.requiredCapabilities,
          outputSchema: args.outputSchema,
          outputName: args.outputName,
          outputJsonSchema: args.outputJsonSchema,
          onReceipt: async (receipt) => {
            const current = ledger.agentRuns.find((item) => item.id === args.agentRun.id);
            if (!current) throw new Error(`Missing agent run ${args.agentRun.id}.`);
            const updated = { ...current, receiptIds: [...current.receiptIds, receipt.id] };
            await commit(
              {
                ...replaceAgentRun(ledger, updated),
                receipts: [...ledger.receipts, receipt],
              },
              {
                type: "TOOL_EXECUTED",
                actorId: args.agent.id,
                taskId: task.id,
                data: { receiptId: receipt.id, tool: receipt.toolName, status: receipt.status },
              },
            );
          },
        });
        const current = ledger.agentRuns.find((item) => item.id === args.agentRun.id);
        if (!current) throw new Error(`Missing agent run ${args.agentRun.id}.`);
        const completed = AgentRunSchema.parse({
          ...current,
          status: "SUCCEEDED",
          completedAt: new Date().toISOString(),
          durationMs: output.durationMs,
          usage: output.usage,
          ...(output.model ? { model: output.model } : {}),
        });
        await commit(replaceAgentRun(ledger, completed), {
          type: "AGENT_COMPLETED",
          actorId: args.agent.id,
          taskId: task.id,
          data: { agentRunId: completed.id, status: completed.status },
        });
        return output.value as T;
      } catch (error) {
        const current = ledger.agentRuns.find((item) => item.id === args.agentRun.id);
        if (current) {
          const failed = AgentRunSchema.parse({
            ...current,
            status: "FAILED",
            completedAt: new Date().toISOString(),
            durationMs: Math.max(0, Date.now() - Date.parse(current.startedAt)),
            error: sanitizeError(error),
          });
          await commit(replaceAgentRun(ledger, failed), {
            type: "AGENT_COMPLETED",
            actorId: args.agent.id,
            taskId: task.id,
            data: { agentRunId: failed.id, status: failed.status },
          });
        }
        throw error;
      }
    };

    const developerPayload = await executeAgent<ReturnType<typeof WorkerPayloadSchema.parse>>({
      agent: developer,
      actor: developerPrincipal,
      agentRun: developerRun,
      prompt: `Implement task ${task.id}: ${task.description}`,
      outputSchema: WorkerPayloadSchema,
      outputName: "implementation_result",
      outputJsonSchema: workerJsonSchema,
    });
    const result = TaskResultSchema.parse({
      ...developerPayload,
      id: newId("RESULT"),
      runId: currentRunId,
      taskId: task.id,
      agentId: developer.id,
      role: developer.role,
      createdAt: new Date().toISOString(),
    });
    const implementationArtifact = await this.artifacts.create({
      runId: currentRunId,
      taskId: task.id,
      type: "IMPLEMENTATION_REPORT",
      title: "Developer implementation report",
      mediaType: "application/json",
      content: `${JSON.stringify(result, null, 2)}\n`,
      createdBy: developer.id,
    });
    task = { ...task, artifactIds: [...task.artifactIds, implementationArtifact.id] };
    await commit(
      {
        ...replaceTask(ledger, task),
        artifacts: [...ledger.artifacts, implementationArtifact],
      },
      {
        type: "ARTIFACT_CREATED",
        actorId: developer.id,
        taskId: task.id,
        data: { artifactId: implementationArtifact.id, type: implementationArtifact.type },
      },
    );
    authorize(developerPrincipal, developer, "SUBMIT_RESULT");
    task = transitionTask(task, { type: "SUBMIT_IMPLEMENTATION", result }, developerPrincipal);
    await commit(
      { ...replaceTask(ledger, task), results: [...ledger.results, result] },
      {
        type: "IMPLEMENTATION_SUBMITTED",
        actorId: developer.id,
        taskId: task.id,
        data: { resultId: result.id, status: result.status },
      },
    );

    authorize(chiefTaskPrincipal, chief, "START_VERIFICATION");
    task = transitionTask(task, { type: "START_VERIFICATION", verifierId: tester.id }, chiefTaskPrincipal);
    const testerRun = createAgentRun(currentRunId, task, tester, this.options.provider);
    await commit(
      { ...replaceTask(ledger, task), agentRuns: [...ledger.agentRuns, testerRun] },
      {
        type: "TEST_STARTED",
        actorId: chief.id,
        taskId: task.id,
        data: { testerId: tester.id, agentRunId: testerRun.id },
      },
    );
    const testerPrincipal = principal(currentRunId, objective.id, tester, task.id);
    const verificationPayload = await executeAgent<ReturnType<typeof VerificationPayloadSchema.parse>>({
      agent: tester,
      actor: testerPrincipal,
      agentRun: testerRun,
      prompt: `Independently verify task ${task.id} against every acceptance criterion.`,
      outputSchema: VerificationPayloadSchema,
      outputName: "verification_result",
      outputJsonSchema: verificationJsonSchema,
    });
    const verification: Verification = VerificationSchema.parse({
      ...verificationPayload,
      id: newId("VERIFY"),
      runId: currentRunId,
      taskId: task.id,
      testerId: tester.id,
      createdAt: new Date().toISOString(),
    });
    const verificationArtifact = await this.artifacts.create({
      runId: currentRunId,
      taskId: task.id,
      type: "TEST_REPORT",
      title: "Independent verification report",
      mediaType: "application/json",
      content: `${JSON.stringify(verification, null, 2)}\n`,
      createdBy: tester.id,
    });
    task = { ...task, artifactIds: [...task.artifactIds, verificationArtifact.id] };
    await commit(
      { ...replaceTask(ledger, task), artifacts: [...ledger.artifacts, verificationArtifact] },
      {
        type: "ARTIFACT_CREATED",
        actorId: tester.id,
        taskId: task.id,
        data: { artifactId: verificationArtifact.id, type: verificationArtifact.type },
      },
    );
    authorize(
      testerPrincipal,
      tester,
      verification.decision === "PASS" ? "PASS_VERIFICATION" : "FAIL_VERIFICATION",
    );
    task = transitionTask(
      task,
      { type: "SUBMIT_VERIFICATION", verification, receipts: ledger.receipts },
      testerPrincipal,
    );
    await commit(
      { ...replaceTask(ledger, task), verifications: [...ledger.verifications, verification] },
      {
        type: "TEST_COMPLETED",
        actorId: tester.id,
        taskId: task.id,
        data: { verificationId: verification.id, decision: verification.decision },
      },
    );
    if (verification.decision !== "PASS") {
      throw new Error(`Demonstration verification did not pass: ${verification.summary}`);
    }

    authorize(chiefTaskPrincipal, chief, "START_REVIEW");
    task = transitionTask(task, { type: "START_REVIEW", reviewerId: reviewer.id }, chiefTaskPrincipal);
    await commit(replaceTask(ledger, task), {
      type: "REVIEW_REQUESTED",
      actorId: chief.id,
      taskId: task.id,
      data: { reviewerId: reviewer.id },
    });
    const reviewerRun = createAgentRun(currentRunId, task, reviewer, this.options.provider);
    await commit(
      { ...ledger, agentRuns: [...ledger.agentRuns, reviewerRun] },
      {
        type: "REVIEW_STARTED",
        actorId: reviewer.id,
        taskId: task.id,
        data: { agentRunId: reviewerRun.id },
      },
    );
    const reviewerPrincipal = principal(currentRunId, objective.id, reviewer, task.id);
    const reviewPayload = await executeAgent<ReturnType<typeof ReviewPayloadSchema.parse>>({
      agent: reviewer,
      actor: reviewerPrincipal,
      agentRun: reviewerRun,
      prompt: `Independently review task ${task.id}, its Git diff, implementation, and acceptance evidence.`,
      outputSchema: ReviewPayloadSchema,
      outputName: "review_result",
      outputJsonSchema: reviewJsonSchema,
    });
    const review: Review = ReviewSchema.parse({
      ...reviewPayload,
      id: newId("REVIEW"),
      runId: currentRunId,
      taskId: task.id,
      reviewerId: reviewer.id,
      createdAt: new Date().toISOString(),
    });
    const reviewArtifact = await this.artifacts.create({
      runId: currentRunId,
      taskId: task.id,
      type: "REVIEW_REPORT",
      title: "Independent review report",
      mediaType: "application/json",
      content: `${JSON.stringify(review, null, 2)}\n`,
      createdBy: reviewer.id,
    });
    task = { ...task, artifactIds: [...task.artifactIds, reviewArtifact.id] };
    await commit(
      { ...replaceTask(ledger, task), artifacts: [...ledger.artifacts, reviewArtifact] },
      {
        type: "ARTIFACT_CREATED",
        actorId: reviewer.id,
        taskId: task.id,
        data: { artifactId: reviewArtifact.id, type: reviewArtifact.type },
      },
    );
    authorize(
      reviewerPrincipal,
      reviewer,
      review.decision === "APPROVE"
        ? "APPROVE"
        : review.decision === "BLOCK"
          ? "BLOCK"
          : "REQUEST_CHANGES",
    );
    task = transitionTask(task, { type: "SUBMIT_REVIEW", review, receipts: ledger.receipts }, reviewerPrincipal);
    await commit(
      { ...replaceTask(ledger, task), reviews: [...ledger.reviews, review] },
      {
        type: review.decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "REVIEW_COMPLETED",
        actorId: reviewer.id,
        taskId: task.id,
        data: { reviewId: review.id, decision: review.decision },
      },
    );
    if (review.decision !== "APPROVE") throw new Error(`Demonstration review was not approved: ${review.summary}`);

    for (const artifact of ledger.artifacts) await this.artifacts.verify(artifact);
    authorize(chiefTaskPrincipal, chief, "ACCEPT_TASK");
    task = transitionTask(
      task,
      {
        type: "ACCEPT",
        verification,
        review,
        validReceiptIds: ledger.receipts.map((receipt) => receipt.id),
      },
      chiefTaskPrincipal,
    );
    await commit(replaceTask(ledger, task), {
      type: "TASK_COMPLETED",
      actorId: chief.id,
      taskId: task.id,
      data: { verificationId: verification.id, reviewId: review.id },
    });

    authorize(chiefObjectivePrincipal, chief, "COMPLETE_OBJECTIVE");
    const completedObjective = completeObjective(
      ledger.objective,
      ledger.tasks,
      chiefObjectivePrincipal,
      ledger.approvals.filter((approval) => approval.status === "PENDING").length,
    );
    await commit({ ...ledger, objective: completedObjective }, {
      type: "OBJECTIVE_COMPLETED",
      actorId: chief.id,
      data: { objectiveId: completedObjective.id },
    });

    const finalReport = await this.artifacts.create({
      runId: currentRunId,
      type: "FINAL_REPORT",
      title: "Chief Engineer final report",
      mediaType: "text/markdown",
      content: finalReportMarkdown(ledger),
      createdBy: chief.id,
    });
    await commit({ ...ledger, artifacts: [...ledger.artifacts, finalReport] }, {
      type: "ARTIFACT_CREATED",
      actorId: chief.id,
      data: { artifactId: finalReport.id, type: finalReport.type },
    });

    return {
      runId: currentRunId,
      ledger,
      runDirectory: this.options.blackboard.runDirectory(currentRunId),
      workspaceDirectory: workspace,
      finalReport,
    };
  }
}
