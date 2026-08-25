#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { AgentProvider } from "@agent-org/core";
import { MockProvider, OpenAIProvider } from "@agent-org/providers";
import {
  FileBlackboard,
  OrganizationRuntime,
  loadConfiguration,
  loadObjective,
  requiredCapabilities,
} from "@agent-org/runtime";
import { LocalToolRegistry, LocalWorkspaceManager } from "@agent-org/tools";
import { Command } from "commander";

const program = new Command();

function repositoryRoot(): string {
  return process.cwd();
}

async function context(runId?: string): Promise<{
  store: FileBlackboard;
  runId: string;
}> {
  const config = await loadConfiguration(repositoryRoot());
  const store = new FileBlackboard(config.stateDirectory);
  return { store, runId: runId ?? (await store.latestRunId()) };
}

function provider(name: string, root: string): AgentProvider {
  if (name === "mock") return new MockProvider();
  if (name === "openai") {
    const envFile = path.join(root, ".env.local");
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    return new OpenAIProvider();
  }
  throw new Error(`Unknown provider ${name}; expected mock or openai.`);
}

program
  .name("agent-org")
  .description("Run and inspect a portable, evidence-driven multi-agent engineering workflow.")
  .version("0.1.0");

program
  .command("run")
  .description("Run an objective YAML file.")
  .argument("<objective>", "path to an objective YAML file")
  .option("--provider <provider>", "provider adapter: mock or openai", "mock")
  .action(async (objectiveFile: string, options: { provider: string }) => {
    const root = repositoryRoot();
    const config = await loadConfiguration(root);
    const store = new FileBlackboard(config.stateDirectory);
    const objective = await loadObjective(path.resolve(root, objectiveFile));
    const runtime = new OrganizationRuntime({
      repositoryRoot: root,
      stateDirectory: config.stateDirectory,
      agents: config.agents,
      requiredCapabilities: requiredCapabilities(config),
      provider: provider(options.provider, root),
      tools: new LocalToolRegistry([
        {
          id: "sample-test",
          description: "Run the sample project's fixed Node test suite.",
          executable: process.execPath,
          args: ["--test", "test/sum.test.mjs"],
          timeoutMs: 30_000,
        },
      ]),
      workspaceManager: new LocalWorkspaceManager(),
      blackboard: store,
    });
    const completed = await runtime.run(objective);
    console.log(
      JSON.stringify(
        {
          runId: completed.runId,
          objective: completed.ledger.objective.status,
          task: completed.ledger.tasks[0]?.status,
          verification: completed.ledger.verifications[0]?.decision,
          review: completed.ledger.reviews[0]?.decision,
          runDirectory: completed.runDirectory,
          workspaceDirectory: completed.workspaceDirectory,
          finalReport: completed.finalReport.path,
        },
        null,
        2,
      ),
    );
  });

program
  .command("status")
  .description("Show objective and run status.")
  .option("--run <runId>", "run ID; defaults to latest")
  .action(async (options: { run?: string }) => {
    const selected = await context(options.run);
    const ledger = await selected.store.load(selected.runId);
    console.log(
      JSON.stringify(
        {
          runId: ledger.runId,
          revision: ledger.revision,
          objectiveId: ledger.objective.id,
          objective: ledger.objective.status,
          tasks: ledger.tasks.reduce<Record<string, number>>((counts, task) => {
            counts[task.status] = (counts[task.status] ?? 0) + 1;
            return counts;
          }, {}),
          receipts: ledger.receipts.length,
          artifacts: ledger.artifacts.length,
          agentRuns: ledger.agentRuns.length,
        },
        null,
        2,
      ),
    );
  });

program
  .command("tasks")
  .description("List tasks in a run.")
  .option("--run <runId>", "run ID; defaults to latest")
  .action(async (options: { run?: string }) => {
    const selected = await context(options.run);
    const ledger = await selected.store.load(selected.runId);
    console.table(
      ledger.tasks.map((task) => ({
        id: task.id,
        status: task.status,
        implementer: task.implementerId ?? "-",
        tester: task.verifierId ?? "-",
        reviewer: task.reviewerId ?? "-",
        rework: task.reworkCount,
      })),
    );
  });

program
  .command("inspect")
  .description("Inspect one task and its evidence records.")
  .argument("<taskId>", "task ID")
  .option("--run <runId>", "run ID; defaults to latest")
  .action(async (taskId: string, options: { run?: string }) => {
    const selected = await context(options.run);
    const ledger = await selected.store.load(selected.runId);
    const task = ledger.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} does not exist in ${selected.runId}.`);
    console.log(
      JSON.stringify(
        {
          task,
          result: ledger.results.find((item) => item.id === task.resultId),
          verification: ledger.verifications.find((item) => item.id === task.verificationId),
          review: ledger.reviews.find((item) => item.id === task.reviewId),
          receipts: ledger.receipts.filter((item) => item.taskId === task.id),
          artifacts: ledger.artifacts.filter((item) => task.artifactIds.includes(item.id)),
        },
        null,
        2,
      ),
    );
  });

for (const collection of ["reviews", "decisions"] as const) {
  program
    .command(collection)
    .description(`List ${collection} in a run.`)
    .option("--run <runId>", "run ID; defaults to latest")
    .action(async (options: { run?: string }) => {
      const selected = await context(options.run);
      const ledger = await selected.store.load(selected.runId);
      console.log(JSON.stringify(ledger[collection], null, 2));
    });
}

program
  .command("events")
  .description("Print the append-only event history.")
  .option("--run <runId>", "run ID; defaults to latest")
  .action(async (options: { run?: string }) => {
    const selected = await context(options.run);
    const events = await selected.store.events(selected.runId);
    console.table(
      events.map((event, index) => ({
        revision: index + 1,
        timestamp: event.timestamp,
        type: event.type,
        actor: event.actorId,
        task: event.taskId ?? "-",
      })),
    );
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
