#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { AgentDefinition, AgentProvider, Role } from "@agent-org/core";
import { MockProvider, OpenAIProvider, type MockProviderOptions } from "@agent-org/providers";
import { EvalExpectationsSchema, FileBlackboard, OrganizationRuntime, evaluateLedger, loadConfiguration, loadObjective, requiredCapabilities } from "@agent-org/runtime";
import { LocalToolRegistry, LocalWorkspaceManager } from "@agent-org/tools";
import { Command } from "commander";

const program = new Command();
const repositoryRoot = (): string => process.cwd();

async function context(runId?: string): Promise<{ store: FileBlackboard; runId: string }> {
  const config = await loadConfiguration(repositoryRoot());
  const store = new FileBlackboard(config.stateDirectory);
  return { store, runId: runId ?? await store.latestRunId() };
}

function loadLocalEnvironment(root: string): void {
  const envFile = path.join(root, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

async function runtimeFor(options: { provider?: string; model?: string; mock?: MockProviderOptions }): Promise<OrganizationRuntime> {
  const root = repositoryRoot();
  const config = await loadConfiguration(root);
  const agents = new Map<Role, AgentDefinition>([...config.agents.entries()].map(([role, agent]) => [
    role,
    {
      ...agent,
      ...(options.provider ? { providerPreference: options.provider } : {}),
      ...(options.model ? { modelPreference: options.model } : {}),
    },
  ]));
  const selectedProviderIds = new Set([...agents.values()].map((agent) => agent.providerPreference ?? "mock"));
  if (selectedProviderIds.has("openai")) loadLocalEnvironment(root);
  const providers = new Map<string, AgentProvider>();
  for (const [id, definition] of Object.entries(config.organization.providers)) {
    if (!selectedProviderIds.has(id)) continue;
    if (definition.type === "mock") providers.set(id, new MockProvider(options.mock));
    else providers.set(id, new OpenAIProvider({
      model: options.model ?? definition.defaultModel,
      ...(definition.inputCostPerMillion === undefined ? {} : { inputCostPerMillion: definition.inputCostPerMillion }),
      ...(definition.outputCostPerMillion === undefined ? {} : { outputCostPerMillion: definition.outputCostPerMillion }),
    }));
  }
  for (const id of selectedProviderIds) if (!providers.has(id)) throw new Error(`No configured provider ${id}.`);
  const selectedDefinition = options.provider ? config.organization.providers[options.provider] : undefined;
  return new OrganizationRuntime({
    repositoryRoot: root,
    stateDirectory: config.stateDirectory,
    agents,
    requiredCapabilities: requiredCapabilities(config),
    providers,
    tools: new LocalToolRegistry([
      { id: "sample-test", description: "Run the sample project's fixed Node test suite.", executable: process.execPath, args: ["--test", "test/sum.test.mjs"], timeoutMs: 30_000 },
      { id: "real-bug-test", description: "Run the order-pricing TypeScript regression suite with Node type stripping.", executable: process.execPath, args: ["--experimental-strip-types", "--test", "test/order.test.mjs"], timeoutMs: 30_000 },
    ]),
    workspaceManager: new LocalWorkspaceManager(),
    blackboard: new FileBlackboard(config.stateDirectory),
    maxRework: config.organization.maxRework,
    executorOptions: {
      timeoutMs: selectedDefinition?.timeoutMs ?? 120_000,
      maxRetries: selectedDefinition?.maxRetries ?? 2,
      retryBackoffMs: selectedDefinition?.retryBackoffMs ?? 500,
    },
  });
}

function runSummary(ledger: Awaited<ReturnType<FileBlackboard["load"]>>): Record<string, unknown> {
  const task = ledger.tasks[0];
  const total = (key: "inputTokens" | "outputTokens" | "costUsd"): number => ledger.agentRuns.reduce((sum, run) => sum + (run.usage[key] ?? 0), 0);
  return {
    runId: ledger.runId,
    lifecycle: ledger.lifecycle,
    objectiveId: ledger.objective.id,
    objective: ledger.objective.status,
    task: task?.status,
    iteration: task?.iteration,
    rework: task?.reworkCount,
    workspaceStateHash: task?.workspaceStateHash,
    verification: ledger.verifications.find((item) => item.id === task?.verificationId)?.decision,
    review: ledger.reviews.find((item) => item.id === task?.reviewId)?.decision,
    providers: [...new Set(ledger.agentRuns.map((run) => run.providerId))],
    models: [...new Set(ledger.agentRuns.map((run) => run.model).filter(Boolean))],
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    estimatedCostUsd: total("costUsd"),
    retries: ledger.agentRuns.reduce((sum, run) => sum + (run.retryCount ?? 0), 0),
    providerErrors: ledger.agentRuns.flatMap((run) => run.providerErrors ?? []).length,
    toolCalls: ledger.receipts.length,
  };
}

program.name("agent-org").description("Run and inspect a portable, evidence-driven multi-agent engineering workflow.").version("0.2.0");

program.command("run").description("Run an objective YAML file.")
  .argument("<objective>", "path to an objective YAML file")
  .option("--provider <provider>", "override every agent provider")
  .option("--model <model>", "override every agent model")
  .action(async (objectiveFile: string, options: { provider?: string; model?: string }) => {
    const runtime = await runtimeFor(options);
    const objective = await loadObjective(path.resolve(repositoryRoot(), objectiveFile));
    const completed = await runtime.run(objective);
    console.log(JSON.stringify({ ...runSummary(completed.ledger), runDirectory: completed.runDirectory, workspaceDirectory: completed.workspaceDirectory, finalReport: completed.finalReport.path }, null, 2));
  });

program.command("resume").description("Resume an interrupted run from its durable stage.")
  .argument("<runId>", "run ID")
  .option("--provider <provider>", "same provider override used when the run started")
  .option("--model <model>", "same model override used when the run started")
  .action(async (runId: string, options: { provider?: string; model?: string }) => {
    const completed = await (await runtimeFor(options)).resume(runId);
    console.log(JSON.stringify({ ...runSummary(completed.ledger), workspaceDirectory: completed.workspaceDirectory, finalReport: completed.finalReport.path }, null, 2));
  });

program.command("status").description("Show objective, task, provider, and usage status.")
  .option("--run <runId>", "run ID; defaults to latest")
  .action(async (options: { run?: string }) => {
    const selected = await context(options.run);
    console.log(JSON.stringify({ revision: (await selected.store.load(selected.runId)).revision, ...runSummary(await selected.store.load(selected.runId)) }, null, 2));
  });

program.command("runs").description("List persisted runs without loading provider credentials.")
  .action(async () => {
    const config = await loadConfiguration(repositoryRoot());
    const store = new FileBlackboard(config.stateDirectory);
    const rows = await Promise.all((await store.listRuns()).map(async (id) => runSummary(await store.load(id))));
    console.table(rows.map((row) => ({ runId: row.runId, lifecycle: row.lifecycle, objective: row.objective, task: row.task, provider: (row.providers as string[]).join(","), model: (row.models as string[]).join(","), retries: row.retries, rework: row.rework })));
  });

program.command("tasks").description("List tasks in a run.")
  .option("--run <runId>", "run ID; defaults to latest")
  .action(async (options: { run?: string }) => {
    const selected = await context(options.run);
    const ledger = await selected.store.load(selected.runId);
    console.table(ledger.tasks.map((task) => ({ id: task.id, status: task.status, implementer: task.implementerId ?? "-", tester: task.verifierId ?? "-", reviewer: task.reviewerId ?? "-", iteration: task.iteration ?? 0, rework: task.reworkCount, workspace: task.workspaceStateHash?.slice(0, 12) ?? "-" })));
  });

program.command("inspect").description("Inspect one task and its evidence records.")
  .argument("<taskId>", "task ID")
  .option("--run <runId>", "run ID; defaults to latest")
  .action(async (taskId: string, options: { run?: string }) => {
    const selected = await context(options.run);
    const ledger = await selected.store.load(selected.runId);
    const task = ledger.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} does not exist in ${selected.runId}.`);
    console.log(JSON.stringify({ task, results: ledger.results.filter((item) => item.taskId === task.id), verifications: ledger.verifications.filter((item) => item.taskId === task.id), reviews: ledger.reviews.filter((item) => item.taskId === task.id), agentRuns: ledger.agentRuns.filter((item) => item.taskId === task.id), receipts: ledger.receipts.filter((item) => item.taskId === task.id), artifacts: ledger.artifacts.filter((item) => task.artifactIds.includes(item.id)) }, null, 2));
  });

for (const collection of ["reviews", "decisions"] as const) {
  program.command(collection).description(`List ${collection} in a run.`).option("--run <runId>", "run ID; defaults to latest")
    .action(async (options: { run?: string }) => { const selected = await context(options.run); console.log(JSON.stringify((await selected.store.load(selected.runId))[collection], null, 2)); });
}

program.command("events").description("Print the append-only event history.")
  .option("--run <runId>", "run ID; defaults to latest")
  .action(async (options: { run?: string }) => {
    const selected = await context(options.run);
    console.table((await selected.store.events(selected.runId)).map((event, index) => ({ revision: index + 1, timestamp: event.timestamp, type: event.type, actor: event.actorId, task: event.taskId ?? "-" })));
  });

program.command("eval").description("Run deterministic orchestration invariant evaluations.")
  .argument("<directory>", "directory containing */case.json")
  .action(async (directory: string) => {
    const root = repositoryRoot();
    const evalRoot = path.resolve(root, directory);
    const caseFiles = (await readdir(evalRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(evalRoot, entry.name, "case.json")).filter(existsSync).sort();
    const config = await loadConfiguration(root);
    const store = new FileBlackboard(config.stateDirectory);
    const results: Array<Record<string, unknown>> = [];
    for (const file of caseFiles) {
      const definition = JSON.parse(await readFile(file, "utf8")) as { name: string; objective: string; mock?: MockProviderOptions; expectFailure?: boolean; expectations: unknown };
      const objective = await loadObjective(path.resolve(root, definition.objective));
      let failure: string | undefined;
      let run: string | undefined;
      try { run = (await (await runtimeFor({ provider: "mock", ...(definition.mock ? { mock: definition.mock } : {}) })).run(objective)).runId; }
      catch (error) { failure = error instanceof Error ? error.message : String(error); run = await store.latestRunId(); }
      const ledger = await store.load(run);
      const evaluated = evaluateLedger(ledger, await store.events(run), EvalExpectationsSchema.parse(definition.expectations));
      const failureExpected = definition.expectFailure ?? false;
      const passed = evaluated.passed && Boolean(failure) === failureExpected;
      results.push({ name: definition.name, runId: run, passed, failure: failure ?? "-", assertions: evaluated.assertions });
    }
    console.table(results.map((result) => ({ name: result.name, runId: result.runId, passed: result.passed, failure: result.failure })));
    const failed = results.filter((result) => !result.passed);
    if (failed.length > 0) throw new Error(`${failed.length} deterministic evaluation(s) failed.`);
  });

try { await program.parseAsync(process.argv); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
