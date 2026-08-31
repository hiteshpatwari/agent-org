import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AgentRunSchema,
  ChiefPlanPayloadSchema,
  ReviewPayloadSchema,
  ReviewSchema,
  TaskResultSchema,
  VerificationPayloadSchema,
  VerificationSchema,
  WorkerPayloadSchema,
  authorize,
  completeObjective,
  providerErrorRecord,
  redactSecrets,
  transitionTask,
  validateTaskGraph,
  type ActorPrincipal,
  type AgentDefinition,
  type AgentProvider,
  type AgentRun,
  type Artifact,
  type ChiefPlanPayload,
  type Ledger,
  type Objective,
  type ObjectiveInput,
  type ProviderAttempt,
  type ProviderCapability,
  type Review,
  type Role,
  type Task,
  type ToolRegistryPort,
  type Verification,
  type WorkspaceManagerPort,
  type WorkspaceSource,
  type WorkspaceState,
} from "@agent-org/core";
import { z } from "zod";

import { AgentExecutor, type AgentExecutorOptions } from "./agent-executor.js";
import { FileArtifactStore } from "./artifacts.js";
import { AgentContextBuilder } from "./context-builder.js";
import type { BlackboardStore, EventInput } from "./storage.js";

export interface OrganizationRuntimeOptions {
  repositoryRoot?: string;
  stateDirectory: string;
  agents: Map<Role, AgentDefinition>;
  requiredCapabilities: ProviderCapability[];
  provider?: AgentProvider;
  providers?: Map<string, AgentProvider>;
  tools: ToolRegistryPort;
  workspaceManager: WorkspaceManagerPort;
  workspaceSource?: WorkspaceSource;
  blackboard: BlackboardStore;
  maxRework?: number;
  executorOptions?: AgentExecutorOptions;
}

export interface CompletedRun {
  runId: string;
  ledger: Ledger;
  runDirectory: string;
  workspaceDirectory: string;
  finalReport: Artifact;
}

function newId(prefix: string): string { return `${prefix}-${randomUUID()}`; }
function runId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  return `RUN-${stamp}-${randomUUID().slice(0, 8)}`;
}

function principal(run: string, objectiveId: string, agent: AgentDefinition, task?: Task): ActorPrincipal {
  return {
    runId: run,
    objectiveId,
    ...(task ? { taskId: task.id, iteration: task.iteration ?? 0 } : {}),
    agentId: agent.id,
    role: agent.role,
  };
}

function replaceTask(ledger: Ledger, task: Task): Ledger {
  return { ...ledger, tasks: ledger.tasks.map((item) => item.id === task.id ? task : item) };
}

function replaceAgentRun(ledger: Ledger, run: AgentRun): Ledger {
  return { ...ledger, agentRuns: ledger.agentRuns.map((item) => item.id === run.id ? run : item) };
}

function jsonSchema<T>(schema: z.ZodType<T>): Record<string, unknown> {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  delete generated.$schema;
  const strictify = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    delete record.default;
    if (record.type === "object" && typeof record.properties === "object" && record.properties !== null) {
      record.required = Object.keys(record.properties as Record<string, unknown>);
    }
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(strictify); else strictify(child);
    }
  };
  strictify(generated);
  return generated;
}

function safeConfiguration(options: OrganizationRuntimeOptions): Record<string, unknown> {
  return {
    requiredCapabilities: options.requiredCapabilities,
    maxRework: options.maxRework ?? 2,
    providerOverride: options.provider?.id,
    agents: [...options.agents.values()].map((agent) => ({
      id: agent.id,
      role: agent.role,
      mission: agent.mission,
      provider: options.provider?.id ?? agent.providerPreference ?? "mock",
      model: agent.modelPreference,
      permissions: agent.permissions,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    executor: {
      timeoutMs: options.executorOptions?.timeoutMs ?? 120_000,
      maxRetries: options.executorOptions?.maxRetries ?? 2,
      maxTurns: options.executorOptions?.maxTurns ?? 8,
      maxToolCalls: options.executorOptions?.maxToolCalls ?? 24,
    },
  };
}

function createTask(objective: Objective, chief: AgentDefinition, plan: ChiefPlanPayload, maxRework: number): Task {
  const requirementIds = new Set(objective.requirements.map((item) => item.id));
  const criterionIds = new Set(objective.acceptanceCriteria.map((item) => item.id));
  if (plan.requirementIds.some((id) => !requirementIds.has(id)) || ![...requirementIds].every((id) => plan.requirementIds.includes(id))) {
    throw new Error("Chief plan must cover exactly the objective requirements.");
  }
  if (plan.acceptanceCriterionIds.some((id) => !criterionIds.has(id)) || ![...criterionIds].every((id) => plan.acceptanceCriterionIds.includes(id))) {
    throw new Error("Chief plan must cover exactly the objective acceptance criteria.");
  }
  if (plan.dependencies.length > 0) throw new Error("The single-task V1 plan cannot invent dependencies.");
  if (plan.blockers.length > 0) throw new Error(`Chief planning is blocked: ${plan.blockers.join("; ")}`);
  const now = new Date().toISOString();
  return {
    id: newId("TASK"),
    objectiveId: objective.id,
    title: plan.title,
    description: plan.description,
    status: "PENDING",
    createdBy: chief.id,
    dependencies: [],
    requirements: [...objective.requirements],
    acceptanceCriteria: [...objective.acceptanceCriteria],
    risk: objective.risk,
    artifactIds: [],
    blockers: [],
    reworkCount: 0,
    iteration: 0,
    maxRework,
    verificationCommandIds: [...objective.verificationCommandIds],
    createdAt: now,
    updatedAt: now,
  };
}

function createAgentRun(run: string, taskId: string, iteration: number, agent: AgentDefinition, provider: AgentProvider): AgentRun {
  return AgentRunSchema.parse({
    id: newId("ARUN"),
    runId: run,
    taskId,
    agentId: agent.id,
    role: agent.role,
    providerId: provider.id,
    ...(agent.modelPreference ? { model: agent.modelPreference } : {}),
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    usage: {},
    receiptIds: [],
    iteration,
    attempts: [],
    retryCount: 0,
    providerErrors: [],
  });
}

function finalReportMarkdown(ledger: Ledger): string {
  const task = ledger.tasks[0];
  const verification = task ? ledger.verifications.find((item) => item.id === task.verificationId) : undefined;
  const review = task ? ledger.reviews.find((item) => item.id === task.reviewId) : undefined;
  const inputTokens = ledger.agentRuns.reduce((sum, run) => sum + (run.usage.inputTokens ?? 0), 0);
  const outputTokens = ledger.agentRuns.reduce((sum, run) => sum + (run.usage.outputTokens ?? 0), 0);
  const retries = ledger.agentRuns.reduce((sum, run) => sum + (run.retryCount ?? 0), 0);
  return [
    `# Objective report: ${ledger.objective.title}`,
    "",
    `- Run: ${ledger.runId}`,
    `- Objective status: ${ledger.objective.status}`,
    `- Task status: ${task?.status ?? "missing"}`,
    `- Verification: ${verification?.decision ?? "missing"}`,
    `- Review: ${review?.decision ?? "missing"}`,
    `- Rework cycles: ${task?.reworkCount ?? 0}`,
    `- Workspace state: ${task?.workspaceStateHash ?? "missing"}`,
    `- Provider/model runs: ${ledger.agentRuns.map((run) => `${run.providerId}/${run.model ?? "unknown"}`).join(", ")}`,
    `- Tokens: ${inputTokens} input / ${outputTokens} output`,
    `- Retries: ${retries}`,
    `- Tool receipts: ${ledger.receipts.length}`,
    "",
    "Completion was accepted only after current-iteration test receipts and independent review evidence matched the accepted workspace state.",
    "",
  ].join("\n");
}

export class OrganizationRuntime {
  private readonly artifacts: FileArtifactStore;
  private readonly contexts = new AgentContextBuilder();

  public constructor(private readonly options: OrganizationRuntimeOptions) {
    this.artifacts = new FileArtifactStore(options.blackboard);
    if (!options.provider && !options.providers) throw new Error("OrganizationRuntime requires a provider or provider map.");
  }

  private agent(role: Role): AgentDefinition {
    const agent = this.options.agents.get(role);
    if (!agent) throw new Error(`No configured agent for ${role}.`);
    return agent;
  }

  private providerFor(agent: AgentDefinition): AgentProvider {
    if (this.options.provider) return this.options.provider;
    const id = agent.providerPreference ?? "mock";
    const provider = this.options.providers?.get(id);
    if (!provider) throw new Error(`No provider adapter configured for ${agent.id} preference ${id}.`);
    return provider;
  }

  public async run(input: ObjectiveInput): Promise<CompletedRun> {
    await this.options.workspaceSource?.preflight?.(input);
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
      lifecycle: "INITIALIZING",
      configurationSnapshot: safeConfiguration(this.options),
      createdAt: now,
      updatedAt: now,
    };
    await this.options.blackboard.createRun(initial, { type: "OBJECTIVE_CREATED", actorId: chief.id, data: { objectiveId: objective.id, title: objective.title } });
    const release = await this.options.blackboard.acquireRunLock(currentRunId);
    try {
      const workspace = this.options.blackboard.workspaceDirectory(currentRunId);
      const preparedWorkspace = this.options.workspaceSource
        ? await this.options.workspaceSource.prepare({ runId: currentRunId, objective, workspacePath: workspace })
        : await (async () => {
            if (!this.options.repositoryRoot) throw new Error("A workspace source or repository root is required.");
            await this.options.workspaceManager.stage(path.resolve(this.options.repositoryRoot, objective.workspaceTemplate), workspace);
            return { sourceType: "template" as const, path: workspace };
          })();
      const state = await this.options.workspaceManager.inspect(workspace);
      let ledger = await this.options.blackboard.load(currentRunId);
      ledger = await this.options.blackboard.commit(currentRunId, ledger.revision, { ...ledger, lifecycle: "RUNNING", workspaceStateHash: state.hash, preparedWorkspace }, { type: "WORKSPACE_STAGED", actorId: chief.id, data: { workspaceStateHash: state.hash, fileCount: state.files.length, ...preparedWorkspace } });
      return await this.advance(ledger, workspace);
    } catch (error) {
      await this.interrupt(currentRunId, error);
      throw error;
    } finally {
      await release();
    }
  }

  public async resume(currentRunId: string): Promise<CompletedRun> {
    const release = await this.options.blackboard.acquireRunLock(currentRunId);
    try {
      let ledger = await this.options.blackboard.load(currentRunId);
      const expected = JSON.stringify(safeConfiguration(this.options));
      if (ledger.configurationSnapshot && JSON.stringify(ledger.configurationSnapshot) !== expected) {
        throw new Error("Current execution configuration differs from the run snapshot; resume refused.");
      }
      if (ledger.lifecycle === "COMPLETED") return await this.completedResult(ledger);
      const interruptedRuns = ledger.agentRuns.map((run) => run.status === "RUNNING" ? AgentRunSchema.parse({ ...run, status: "FAILED", completedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - Date.parse(run.startedAt)), error: "Process interrupted before durable agent completion." }) : run);
      ledger = await this.options.blackboard.commit(currentRunId, ledger.revision, { ...ledger, lifecycle: "RUNNING", agentRuns: interruptedRuns }, { type: "RUN_RESUMED", actorId: this.agent("CHIEF_ENGINEER").id, data: { interruptedAgentRuns: interruptedRuns.filter((run, index) => run !== ledger.agentRuns[index]).map((run) => run.id) } });
      return await this.advance(ledger, this.options.blackboard.workspaceDirectory(currentRunId));
    } catch (error) {
      await this.interrupt(currentRunId, error);
      throw error;
    } finally {
      await release();
    }
  }

  private async interrupt(currentRunId: string, error: unknown): Promise<void> {
    try {
      const ledger = await this.options.blackboard.load(currentRunId);
      if (ledger.lifecycle === "COMPLETED" || ledger.lifecycle === "FAILED") return;
      await this.options.blackboard.commit(currentRunId, ledger.revision, { ...ledger, lifecycle: "INTERRUPTED" }, { type: "RUN_INTERRUPTED", actorId: this.agent("CHIEF_ENGINEER").id, data: { error: redactSecrets(error instanceof Error ? error.message : String(error)) } });
    } catch {
      // Preserve the primary failure if interruption recording itself is unavailable.
    }
  }

  private async advance(startingLedger: Ledger, workspace: string): Promise<CompletedRun> {
    let ledger = startingLedger;
    const currentRunId = ledger.runId;
    const chief = this.agent("CHIEF_ENGINEER");
    const developer = this.agent("DEVELOPER");
    const tester = this.agent("TESTER");
    const reviewer = this.agent("REVIEWER");
    const commit = async (next: Ledger, event: EventInput): Promise<void> => {
      ledger = await this.options.blackboard.commit(currentRunId, ledger.revision, next, event);
    };

    if (ledger.tasks.length === 0) {
      const workspaceState = await this.options.workspaceManager.inspect(workspace);
      const chiefProvider = this.providerFor(chief);
      let chiefRun = createAgentRun(currentRunId, `PLAN-${ledger.objective.id}`, 0, chief, chiefProvider);
      await commit({ ...ledger, agentRuns: [...ledger.agentRuns, chiefRun] }, { type: "AGENT_STARTED", actorId: chief.id, data: { agentRunId: chiefRun.id, role: chief.role, provider: chiefProvider.id } });
      const plan = await this.executeAgent({ ledger, workspace, workspaceState, agent: chief, actor: principal(currentRunId, ledger.objective.id, chief), agentRun: chiefRun, prompt: "Create one minimal implementation task that covers every supplied requirement and acceptance criterion. Do not invent scope or dependencies.", outputSchema: ChiefPlanPayloadSchema, outputName: "chief_plan", commit });
      ledger = plan.ledger;
      chiefRun = plan.agentRun;
      authorize(principal(currentRunId, ledger.objective.id, chief), chief, "CREATE_TASK");
      const task = createTask(ledger.objective, chief, plan.value, this.options.maxRework ?? 2);
      validateTaskGraph([task]);
      await commit({ ...ledger, objective: { ...ledger.objective, taskIds: [task.id], updatedAt: new Date().toISOString() }, tasks: [task] }, { type: "TASK_CREATED", actorId: chief.id, taskId: task.id, data: { title: task.title, planningAgentRunId: chiefRun.id } });
    }

    for (let guard = 0; guard < 50; guard += 1) {
      let task = ledger.tasks[0];
      if (!task) throw new Error("Run has no task after planning.");
      const chiefTaskPrincipal = principal(currentRunId, ledger.objective.id, chief, task);
      if (task.status === "PENDING") {
        task = transitionTask(task, { type: "MARK_READY", completedDependencyIds: [] }, chiefTaskPrincipal);
        await commit(replaceTask(ledger, task), { type: "TASK_READY", actorId: chief.id, taskId: task.id });
        continue;
      }
      if (task.status === "READY") {
        if (!task.implementerId) {
          authorize(chiefTaskPrincipal, chief, "ASSIGN_TASK");
          task = transitionTask(task, { type: "ASSIGN_IMPLEMENTER", implementerId: developer.id }, chiefTaskPrincipal);
          await commit(replaceTask(ledger, task), { type: "TASK_ASSIGNED", actorId: chief.id, taskId: task.id, data: { assigneeId: developer.id } });
          continue;
        }
        const developerPrincipal = principal(currentRunId, ledger.objective.id, developer, task);
        authorize(developerPrincipal, developer, "CLAIM_TASK");
        task = transitionTask(task, { type: "CLAIM_IMPLEMENTATION" }, developerPrincipal);
        await commit(replaceTask(ledger, task), { type: "AGENT_STARTED", actorId: developer.id, taskId: task.id, data: { role: developer.role, stage: "implementation" } });
        continue;
      }
      if (task.status === "IN_PROGRESS") {
        const provider = this.providerFor(developer);
        let agentRun = createAgentRun(currentRunId, task.id, task.iteration ?? 0, developer, provider);
        await commit({ ...ledger, agentRuns: [...ledger.agentRuns, agentRun] }, { type: "AGENT_STARTED", actorId: developer.id, taskId: task.id, data: { agentRunId: agentRun.id, role: developer.role, provider: provider.id } });
        const stateBefore = await this.options.workspaceManager.inspect(workspace);
        const executed = await this.executeAgent({ ledger, workspace, workspaceState: stateBefore, agent: developer, actor: principal(currentRunId, ledger.objective.id, developer, task), agentRun, prompt: `Implement task ${task.id}. Inspect the repository, make the smallest correct multi-file change, update tests, and cite only actual receipt IDs.`, outputSchema: WorkerPayloadSchema, outputName: "implementation_result", commit, task });
        ledger = executed.ledger;
        agentRun = executed.agentRun;
        const state = await this.options.workspaceManager.inspect(workspace);
        task = { ...ledger.tasks[0]!, workspaceStateHash: state.hash };
        const result = TaskResultSchema.parse({ ...executed.value, id: newId("RESULT"), runId: currentRunId, taskId: task.id, agentId: developer.id, role: developer.role, agentRunId: agentRun.id, iteration: task.iteration ?? 0, workspaceStateHash: state.hash, createdAt: new Date().toISOString() });
        const artifact = await this.artifacts.create({ runId: currentRunId, taskId: task.id, type: "IMPLEMENTATION_REPORT", title: `Developer implementation report iteration ${task.iteration ?? 0}`, mediaType: "application/json", content: `${JSON.stringify(result, null, 2)}\n`, createdBy: developer.id, agentRunId: agentRun.id, iteration: task.iteration ?? 0, workspaceStateHash: state.hash });
        task = { ...task, artifactIds: [...task.artifactIds, artifact.id] };
        await commit({ ...replaceTask(ledger, task), artifacts: [...ledger.artifacts, artifact] }, { type: "ARTIFACT_CREATED", actorId: developer.id, taskId: task.id, data: { artifactId: artifact.id, type: artifact.type } });
        authorize(principal(currentRunId, ledger.objective.id, developer, task), developer, "SUBMIT_RESULT");
        task = transitionTask(task, { type: "SUBMIT_IMPLEMENTATION", result, receipts: ledger.receipts }, principal(currentRunId, ledger.objective.id, developer, task));
        await commit({ ...replaceTask(ledger, task), results: [...ledger.results, result], workspaceStateHash: state.hash }, { type: "IMPLEMENTATION_SUBMITTED", actorId: developer.id, taskId: task.id, data: { resultId: result.id, status: result.status, iteration: task.iteration, workspaceStateHash: state.hash } });
        continue;
      }
      if (task.status === "VERIFICATION_REQUIRED") {
        authorize(chiefTaskPrincipal, chief, "START_VERIFICATION");
        task = transitionTask(task, { type: "START_VERIFICATION", verifierId: tester.id }, chiefTaskPrincipal);
        await commit(replaceTask(ledger, task), { type: "TEST_STARTED", actorId: chief.id, taskId: task.id, data: { testerId: tester.id, iteration: task.iteration } });
        continue;
      }
      if (task.status === "VERIFYING") {
        const provider = this.providerFor(tester);
        let agentRun = createAgentRun(currentRunId, task.id, task.iteration ?? 0, tester, provider);
        await commit({ ...ledger, agentRuns: [...ledger.agentRuns, agentRun] }, { type: "AGENT_STARTED", actorId: tester.id, taskId: task.id, data: { agentRunId: agentRun.id, role: tester.role, provider: provider.id } });
        const state = await this.options.workspaceManager.inspect(workspace);
        if (state.hash !== task.workspaceStateHash) throw new Error("Workspace changed after implementation evidence was recorded.");
        const executed = await this.executeAgent({ ledger, workspace, workspaceState: state, agent: tester, actor: principal(currentRunId, ledger.objective.id, tester, task), agentRun, prompt: `Independently verify task ${task.id}. Execute every configured verification command and report each actual result.`, outputSchema: VerificationPayloadSchema, outputName: "verification_result", commit, task });
        ledger = executed.ledger;
        agentRun = executed.agentRun;
        const after = await this.options.workspaceManager.inspect(workspace);
        if (after.hash !== state.hash) throw new Error("Tester changed the accepted repository state.");
        const verification: Verification = VerificationSchema.parse({ ...executed.value, id: newId("VERIFY"), runId: currentRunId, taskId: task.id, testerId: tester.id, agentRunId: agentRun.id, iteration: task.iteration ?? 0, workspaceStateHash: state.hash, createdAt: new Date().toISOString() });
        const artifact = await this.artifacts.create({ runId: currentRunId, taskId: task.id, type: "TEST_REPORT", title: `Independent verification report iteration ${task.iteration ?? 0}`, mediaType: "application/json", content: `${JSON.stringify(verification, null, 2)}\n`, createdBy: tester.id, agentRunId: agentRun.id, iteration: task.iteration ?? 0, workspaceStateHash: state.hash });
        task = { ...ledger.tasks[0]!, artifactIds: [...ledger.tasks[0]!.artifactIds, artifact.id] };
        await commit({ ...replaceTask(ledger, task), artifacts: [...ledger.artifacts, artifact] }, { type: "ARTIFACT_CREATED", actorId: tester.id, taskId: task.id, data: { artifactId: artifact.id, type: artifact.type } });
        const testerPrincipal = principal(currentRunId, ledger.objective.id, tester, task);
        authorize(testerPrincipal, tester, verification.decision === "PASS" ? "PASS_VERIFICATION" : "FAIL_VERIFICATION");
        task = transitionTask(task, { type: "SUBMIT_VERIFICATION", verification, receipts: ledger.receipts }, testerPrincipal);
        await commit({ ...replaceTask(ledger, task), verifications: [...ledger.verifications, verification] }, { type: "TEST_COMPLETED", actorId: tester.id, taskId: task.id, data: { verificationId: verification.id, decision: verification.decision, iteration: task.iteration } });
        continue;
      }
      if (task.status === "REVIEW_REQUIRED") {
        authorize(chiefTaskPrincipal, chief, "START_REVIEW");
        task = transitionTask(task, { type: "START_REVIEW", reviewerId: reviewer.id }, chiefTaskPrincipal);
        await commit(replaceTask(ledger, task), { type: "REVIEW_REQUESTED", actorId: chief.id, taskId: task.id, data: { reviewerId: reviewer.id, iteration: task.iteration } });
        continue;
      }
      if (task.status === "REVIEWING") {
        const provider = this.providerFor(reviewer);
        let agentRun = createAgentRun(currentRunId, task.id, task.iteration ?? 0, reviewer, provider);
        await commit({ ...ledger, agentRuns: [...ledger.agentRuns, agentRun] }, { type: "REVIEW_STARTED", actorId: reviewer.id, taskId: task.id, data: { agentRunId: agentRun.id, provider: provider.id, iteration: task.iteration } });
        const state = await this.options.workspaceManager.inspect(workspace);
        if (state.hash !== task.workspaceStateHash) throw new Error("Workspace changed before independent review.");
        const executed = await this.executeAgent({ ledger, workspace, workspaceState: state, agent: reviewer, actor: principal(currentRunId, ledger.objective.id, reviewer, task), agentRun, prompt: `Independently review task ${task.id}. Inspect the diff and relevant code directly, evaluate test evidence, and do not rely on developer reasoning.`, outputSchema: ReviewPayloadSchema, outputName: "review_result", commit, task });
        ledger = executed.ledger;
        agentRun = executed.agentRun;
        const after = await this.options.workspaceManager.inspect(workspace);
        if (after.hash !== state.hash) throw new Error("Reviewer modified the accepted repository state.");
        const review: Review = ReviewSchema.parse({ ...executed.value, id: newId("REVIEW"), runId: currentRunId, taskId: task.id, reviewerId: reviewer.id, agentRunId: agentRun.id, iteration: task.iteration ?? 0, workspaceStateHash: state.hash, createdAt: new Date().toISOString() });
        const artifact = await this.artifacts.create({ runId: currentRunId, taskId: task.id, type: "REVIEW_REPORT", title: `Independent review report iteration ${task.iteration ?? 0}`, mediaType: "application/json", content: `${JSON.stringify(review, null, 2)}\n`, createdBy: reviewer.id, agentRunId: agentRun.id, iteration: task.iteration ?? 0, workspaceStateHash: state.hash });
        task = { ...ledger.tasks[0]!, artifactIds: [...ledger.tasks[0]!.artifactIds, artifact.id] };
        await commit({ ...replaceTask(ledger, task), artifacts: [...ledger.artifacts, artifact] }, { type: "ARTIFACT_CREATED", actorId: reviewer.id, taskId: task.id, data: { artifactId: artifact.id, type: artifact.type } });
        const reviewerPrincipal = principal(currentRunId, ledger.objective.id, reviewer, task);
        authorize(reviewerPrincipal, reviewer, review.decision === "APPROVE" ? "APPROVE" : review.decision === "BLOCK" ? "BLOCK" : "REQUEST_CHANGES");
        task = transitionTask(task, { type: "SUBMIT_REVIEW", review, receipts: ledger.receipts }, reviewerPrincipal);
        await commit({ ...replaceTask(ledger, task), reviews: [...ledger.reviews, review] }, { type: review.decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "REVIEW_COMPLETED", actorId: reviewer.id, taskId: task.id, data: { reviewId: review.id, decision: review.decision, iteration: task.iteration } });
        continue;
      }
      if (task.status === "CHANGES_REQUESTED") {
        if (task.reworkCount >= (task.maxRework ?? this.options.maxRework ?? 2)) {
          task = transitionTask(task, { type: "BLOCK", reason: "Configured rework limit exhausted." }, chiefTaskPrincipal);
          await commit(replaceTask(ledger, task), { type: "REWORK_EXHAUSTED", actorId: chief.id, taskId: task.id, data: { reworkCount: task.reworkCount } });
          throw new Error("Workflow stopped after exhausting the configured rework limit.");
        }
        task = transitionTask(task, { type: "REOPEN", implementerId: developer.id }, chiefTaskPrincipal);
        await commit(replaceTask(ledger, task), { type: "REWORK_STARTED", actorId: chief.id, taskId: task.id, data: { iteration: task.iteration, reworkCount: task.reworkCount } });
        continue;
      }
      if (task.status === "ACCEPTANCE_REQUIRED") {
        for (const artifact of ledger.artifacts) await this.artifacts.verify(artifact);
        const verificationId = task.verificationId;
        const reviewId = task.reviewId;
        const verification = ledger.verifications.find((item) => item.id === verificationId);
        const review = ledger.reviews.find((item) => item.id === reviewId);
        if (!verification || !review) throw new Error("Acceptance records are missing.");
        authorize(chiefTaskPrincipal, chief, "ACCEPT_TASK");
        task = transitionTask(task, { type: "ACCEPT", verification, review, validReceiptIds: ledger.receipts.map((receipt) => receipt.id) }, chiefTaskPrincipal);
        await commit(replaceTask(ledger, task), { type: "TASK_COMPLETED", actorId: chief.id, taskId: task.id, data: { verificationId: verification.id, reviewId: review.id, iteration: task.iteration, workspaceStateHash: task.workspaceStateHash } });
        continue;
      }
      if (task.status === "COMPLETED") {
        if (ledger.objective.status !== "COMPLETED") {
          const chiefObjectivePrincipal = principal(currentRunId, ledger.objective.id, chief);
          authorize(chiefObjectivePrincipal, chief, "COMPLETE_OBJECTIVE");
          const completedObjective = completeObjective(ledger.objective, ledger.tasks, chiefObjectivePrincipal, ledger.approvals.filter((approval) => approval.status === "PENDING").length);
          await commit({ ...ledger, objective: completedObjective }, { type: "OBJECTIVE_COMPLETED", actorId: chief.id, data: { objectiveId: completedObjective.id } });
          continue;
        }
        const existing = ledger.artifacts.find((artifact) => artifact.type === "FINAL_REPORT");
        if (!existing) {
          const report = await this.artifacts.create({
            runId: currentRunId,
            type: "FINAL_REPORT",
            title: "Chief Engineer final report",
            mediaType: "text/markdown",
            content: finalReportMarkdown(ledger),
            createdBy: chief.id,
            ...(task.iteration === undefined ? {} : { iteration: task.iteration }),
            ...(task.workspaceStateHash ? { workspaceStateHash: task.workspaceStateHash } : {}),
          });
          await commit({ ...ledger, artifacts: [...ledger.artifacts, report], lifecycle: "COMPLETED" }, { type: "ARTIFACT_CREATED", actorId: chief.id, data: { artifactId: report.id, type: report.type } });
        } else if (ledger.lifecycle !== "COMPLETED") {
          await commit({ ...ledger, lifecycle: "COMPLETED" }, { type: "ARTIFACT_CREATED", actorId: chief.id, data: { artifactId: existing.id, reconciled: true } });
        }
        return await this.completedResult(ledger);
      }
      throw new Error(`Workflow stopped safely with task ${task.id} in ${task.status}.`);
    }
    throw new Error("Workflow exceeded its orchestration transition limit.");
  }

  private async executeAgent<T>(input: {
    ledger: Ledger;
    workspace: string;
    workspaceState: WorkspaceState;
    agent: AgentDefinition;
    actor: ActorPrincipal;
    agentRun: AgentRun;
    prompt: string;
    outputSchema: z.ZodType<T>;
    outputName: string;
    task?: Task;
    commit: (next: Ledger, event: EventInput) => Promise<void>;
  }): Promise<{ value: T; ledger: Ledger; agentRun: AgentRun }> {
    let ledger = input.ledger;
    const provider = this.providerFor(input.agent);
    const executor = new AgentExecutor(provider, this.options.tools, this.options.executorOptions);
    const currentLedger = async (): Promise<Ledger> => await this.options.blackboard.load(ledger.runId);
    const commit = async (next: Ledger, event: EventInput): Promise<void> => {
      await input.commit(next, event);
      ledger = await currentLedger();
    };
    try {
      const output = await executor.execute({
        principal: input.actor,
        agent: input.agent,
        workspacePath: input.workspace,
        prompt: input.prompt,
        context: this.contexts.build({ role: input.agent.role, agent: input.agent, ledger, ...(input.task ? { task: input.task } : {}), workspace: input.workspaceState }),
        requiredCapabilities: this.options.requiredCapabilities,
        outputSchema: input.outputSchema,
        outputName: input.outputName,
        outputJsonSchema: jsonSchema(input.outputSchema),
        onReceipt: async (receipt) => {
          ledger = await currentLedger();
          const current = ledger.agentRuns.find((item) => item.id === input.agentRun.id);
          if (!current) throw new Error(`Missing agent run ${input.agentRun.id}.`);
          const updated = AgentRunSchema.parse({ ...current, receiptIds: [...current.receiptIds, receipt.id], workspaceStateHash: receipt.workspaceStateHash });
          await commit({ ...replaceAgentRun(ledger, updated), receipts: [...ledger.receipts, receipt] }, { type: "TOOL_EXECUTED", actorId: input.agent.id, ...(input.task ? { taskId: input.task.id } : {}), data: { receiptId: receipt.id, tool: receipt.toolName, status: receipt.status, iteration: receipt.iteration, workspaceStateHash: receipt.workspaceStateHash } });
        },
        onAttempt: async (attempt: ProviderAttempt) => {
          ledger = await currentLedger();
          const current = ledger.agentRuns.find((item) => item.id === input.agentRun.id);
          if (!current) return;
          const attempts = [...(current.attempts ?? [])];
          const index = attempts.findIndex((item) => item.number === attempt.number);
          if (index >= 0) attempts[index] = attempt; else attempts.push(attempt);
          const providerErrors = attempt.error ? [...(current.providerErrors ?? []), attempt.error] : current.providerErrors ?? [];
          const updated = AgentRunSchema.parse({ ...current, attempts, providerErrors });
          await commit(replaceAgentRun(ledger, updated), { type: "PROVIDER_ATTEMPTED", actorId: input.agent.id, ...(input.task ? { taskId: input.task.id } : {}), data: { agentRunId: current.id, attempt: attempt.number, turn: attempt.turn, status: attempt.status, errorCode: attempt.error?.code } });
        },
        onRetry: async (error, retryNumber) => {
          ledger = await currentLedger();
          const current = ledger.agentRuns.find((item) => item.id === input.agentRun.id);
          if (!current) return;
          const updated = AgentRunSchema.parse({ ...current, retryCount: retryNumber });
          await commit(replaceAgentRun(ledger, updated), { type: "PROVIDER_RETRY_SCHEDULED", actorId: input.agent.id, ...(input.task ? { taskId: input.task.id } : {}), data: { agentRunId: current.id, retryNumber, code: error.code } });
        },
      });
      ledger = await currentLedger();
      const current = ledger.agentRuns.find((item) => item.id === input.agentRun.id);
      if (!current) throw new Error(`Missing agent run ${input.agentRun.id}.`);
      const completed = AgentRunSchema.parse({ ...current, status: "SUCCEEDED", completedAt: new Date().toISOString(), durationMs: output.durationMs, usage: output.usage, retryCount: output.retryCount, attempts: output.attempts, ...(output.model ? { model: output.model } : {}) });
      await commit(replaceAgentRun(ledger, completed), { type: "AGENT_COMPLETED", actorId: input.agent.id, ...(input.task ? { taskId: input.task.id } : {}), data: { agentRunId: completed.id, status: completed.status, provider: completed.providerId, model: completed.model, durationMs: completed.durationMs, retries: completed.retryCount } });
      return { value: output.value, ledger, agentRun: completed };
    } catch (error) {
      ledger = await currentLedger();
      const current = ledger.agentRuns.find((item) => item.id === input.agentRun.id);
      if (current) {
        const normalized = providerErrorRecord(error, provider.id);
        const errors = [...(current.providerErrors ?? [])];
        if (!errors.some((item) => item.code === normalized.code && item.message === normalized.message && item.statusCode === normalized.statusCode)) errors.push(normalized);
        const failed = AgentRunSchema.parse({ ...current, status: "FAILED", completedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - Date.parse(current.startedAt)), error: normalized.message, providerErrors: errors });
        await commit(replaceAgentRun(ledger, failed), { type: "PROVIDER_FAILED", actorId: input.agent.id, ...(input.task ? { taskId: input.task.id } : {}), data: { agentRunId: failed.id, code: normalized.code, retryable: normalized.retryable } });
      }
      throw error;
    }
  }

  private async completedResult(ledger: Ledger): Promise<CompletedRun> {
    const finalReport = ledger.artifacts.find((artifact) => artifact.type === "FINAL_REPORT");
    if (!finalReport) throw new Error(`Completed run ${ledger.runId} is missing its final report.`);
    return { runId: ledger.runId, ledger, runDirectory: this.options.blackboard.runDirectory(ledger.runId), workspaceDirectory: this.options.blackboard.workspaceDirectory(ledger.runId), finalReport };
  }
}
