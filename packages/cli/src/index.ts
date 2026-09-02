#!/usr/bin/env node
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { RiskSchema, type AgentDefinition, type AgentProvider, type Role } from "@agent-org/core";
import { MockProvider, OpenAIProvider, type MockProviderOptions } from "@agent-org/providers";
import { EvalExpectationsSchema, FileBlackboard, ObjectiveBuilder, OrganizationRuntime, discoverProjectCommands, discoverProjectContextFiles, evaluateLedger, loadConfiguration, loadGlobalConfiguration, loadObjective, loadProjectConfiguration, requiredCapabilities, resolveProjectModePaths, type LoadedConfiguration } from "@agent-org/runtime";
import { LocalGitWorkspaceSource, LocalToolRegistry, LocalWorkspaceManager, TemplateWorkspaceSource, type CommandTemplate } from "@agent-org/tools";
import { Command } from "commander";

interface ProviderOptions { provider?: string; model?: string }
interface PromptOptions extends ProviderOptions { risk?: string }

const program = new Command();
const execFileAsync = promisify(execFile);
const cwd = (): string => process.cwd();

function rawOption(name: string): string | undefined {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function loadLocalEnvironment(root: string): void {
  const file = path.join(root, ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

function fixtureCommands(): CommandTemplate[] {
  return [
    { id: "sample-test", description: "Run the sample project's fixed Node test suite.", executable: process.execPath, args: ["--test", "test/sum.test.mjs"], timeoutMs: 30_000 },
    { id: "real-bug-test", description: "Run the order-pricing TypeScript regression suite.", executable: process.execPath, args: ["--experimental-strip-types", "--test", "test/order.test.mjs"], timeoutMs: 30_000 },
  ];
}

function agentsFor(configuration: LoadedConfiguration, options: ProviderOptions): Map<Role, AgentDefinition> {
  return new Map([...configuration.agents].map(([role, agent]) => [role, { ...agent, ...(options.provider ? { providerPreference: options.provider } : {}), ...(options.model ? { modelPreference: options.model } : {}) }]));
}

function providersFor(configuration: LoadedConfiguration, agents: Map<Role, AgentDefinition>, options: ProviderOptions & { mock?: MockProviderOptions }): Map<string, AgentProvider> {
  const selected = new Set([...agents.values()].map((agent) => agent.providerPreference ?? "mock"));
  const providers = new Map<string, AgentProvider>();
  for (const [id, definition] of Object.entries(configuration.organization.providers)) {
    if (!selected.has(id)) continue;
    providers.set(id, definition.type === "mock" ? new MockProvider(options.mock) : new OpenAIProvider({ model: options.model ?? definition.defaultModel, ...(definition.inputCostPerMillion === undefined ? {} : { inputCostPerMillion: definition.inputCostPerMillion }), ...(definition.outputCostPerMillion === undefined ? {} : { outputCostPerMillion: definition.outputCostPerMillion }) }));
  }
  for (const id of selected) if (!providers.has(id)) throw new Error(`No configured provider ${id}.`);
  return providers;
}

function compose(input: { configuration: LoadedConfiguration; stateDirectory: string; environmentRoot: string; options: ProviderOptions & { mock?: MockProviderOptions }; commands: CommandTemplate[]; workspaceSource: TemplateWorkspaceSource | LocalGitWorkspaceSource }): OrganizationRuntime {
  const agents = agentsFor(input.configuration, input.options);
  if ([...agents.values()].some((agent) => (agent.providerPreference ?? "mock") === "openai")) loadLocalEnvironment(input.environmentRoot);
  const selectedIds = new Set([...agents.values()].map((agent) => agent.providerPreference ?? "mock"));
  const selectedId = input.options.provider ?? (selectedIds.size === 1 ? [...selectedIds][0] : undefined);
  const selectedDefinition = selectedId ? input.configuration.organization.providers[selectedId] : undefined;
  return new OrganizationRuntime({
    stateDirectory: input.stateDirectory,
    agents,
    requiredCapabilities: requiredCapabilities(input.configuration),
    providers: providersFor(input.configuration, agents, input.options),
    tools: new LocalToolRegistry(input.commands),
    workspaceManager: new LocalWorkspaceManager(),
    workspaceSource: input.workspaceSource,
    blackboard: new FileBlackboard(input.stateDirectory),
    maxRework: input.configuration.organization.maxRework,
    executorOptions: { timeoutMs: selectedDefinition?.timeoutMs ?? 120_000, maxRetries: selectedDefinition?.maxRetries ?? 2, retryBackoffMs: selectedDefinition?.retryBackoffMs ?? 500 },
  });
}

async function legacyRuntime(root: string, options: ProviderOptions & { mock?: MockProviderOptions }): Promise<OrganizationRuntime> {
  const configuration = await loadConfiguration(root);
  return compose({ configuration, stateDirectory: configuration.stateDirectory, environmentRoot: root, options, commands: fixtureCommands(), workspaceSource: new TemplateWorkspaceSource(root) });
}

async function projectSetup(options: ProviderOptions & { mock?: MockProviderOptions }) {
  const paths = await resolveProjectModePaths(cwd());
  const projectConfiguration = await loadProjectConfiguration(paths.projectRoot, paths.agentOrgHome);
  const commands = await discoverProjectCommands(paths.projectRoot, projectConfiguration);
  const configuration = await loadGlobalConfiguration(paths.agentOrgHome, paths.runtimeStateRoot);
  return {
    paths,
    projectConfiguration,
    commands,
    store: new FileBlackboard(paths.runtimeStateRoot),
    runtime: compose({ configuration, stateDirectory: paths.runtimeStateRoot, environmentRoot: paths.projectRoot, options, commands, workspaceSource: new LocalGitWorkspaceSource(paths.projectRoot) }),
  };
}

function summary(ledger: Awaited<ReturnType<FileBlackboard["load"]>>): Record<string, unknown> {
  const task = ledger.tasks[0];
  const total = (key: "inputTokens" | "outputTokens" | "costUsd"): number => ledger.agentRuns.reduce((sum, run) => sum + (run.usage[key] ?? 0), 0);
  return {
    runId: ledger.runId, lifecycle: ledger.lifecycle, objectiveId: ledger.objective.id, objectiveTitle: ledger.objective.title, objective: ledger.objective.status,
    task: task?.status, iteration: task?.iteration, rework: task?.reworkCount, workspaceStateHash: task?.workspaceStateHash,
    branch: ledger.preparedWorkspace?.branch, worktree: ledger.preparedWorkspace?.path, projectRoot: ledger.preparedWorkspace?.projectRoot,
    changedFiles: ledger.results.at(-1)?.filesChanged ?? [], verification: ledger.verifications.find((item) => item.id === task?.verificationId)?.decision, review: ledger.reviews.find((item) => item.id === task?.reviewId)?.decision,
    providers: [...new Set(ledger.agentRuns.map((run) => run.providerId))], models: [...new Set(ledger.agentRuns.map((run) => run.model).filter(Boolean))],
    inputTokens: total("inputTokens"), outputTokens: total("outputTokens"), estimatedCostUsd: total("costUsd"), retries: ledger.agentRuns.reduce((sum, run) => sum + (run.retryCount ?? 0), 0), providerErrors: ledger.agentRuns.flatMap((run) => run.providerErrors ?? []).length, toolCalls: ledger.receipts.length,
  };
}

function completedSummary(completed: Awaited<ReturnType<OrganizationRuntime["run"]>>): Record<string, unknown> {
  return { ...summary(completed.ledger), runDirectory: completed.runDirectory, workspaceDirectory: completed.workspaceDirectory, finalReport: completed.finalReport.path };
}

async function runProject(prompt: string, options: PromptOptions): Promise<void> {
  const setup = await projectSetup(options);
  const objective = new ObjectiveBuilder().build({
    prompt,
    projectRoot: setup.paths.projectRoot,
    contextFiles: discoverProjectContextFiles(setup.paths.projectRoot, setup.projectConfiguration.context.include),
    verificationCommandIds: setup.commands.map((command) => command.id),
    risk: options.risk ? RiskSchema.parse(options.risk.toUpperCase()) : setup.projectConfiguration.risk.default,
  });
  console.log(JSON.stringify(completedSummary(await setup.runtime.run(objective)), null, 2));
}

async function runInput(input: string[], options: PromptOptions & { objectiveFile?: string }): Promise<void> {
  const explicit = options.objectiveFile;
  const compatible = input.length === 1 && /\.ya?ml$/iu.test(input[0]!) && existsSync(path.resolve(cwd(), input[0]!));
  if (explicit && input.length > 0) throw new Error("Use either a prompt or --objective-file, not both.");
  if (explicit || compatible) {
    const file = explicit ?? input[0]!;
    const runtime = await legacyRuntime(cwd(), options);
    console.log(JSON.stringify(completedSummary(await runtime.run(await loadObjective(path.resolve(cwd(), file)))), null, 2));
    return;
  }
  await runProject(input.join(" "), options);
}

async function selectedStore(runId?: string): Promise<{ store: FileBlackboard; runId: string }> {
  const legacy = path.join(cwd(), ".agent-org", "state", "latest.json");
  const store = existsSync(legacy) ? new FileBlackboard((await loadConfiguration(cwd())).stateDirectory) : (await projectSetup({ provider: "mock" })).store;
  return { store, runId: runId ?? await store.latestRunId() };
}

program.name("agent-org").description("Run and inspect a portable, evidence-driven multi-agent engineering workflow.").version("0.3.0")
  .argument("[prompt...]", "engineering objective for the current Git repository")
  .option("--provider <provider>", "override every agent provider").option("--model <model>", "override every agent model").option("--risk <risk>", "LOW, MEDIUM, HIGH, or CRITICAL")
  .action(async (prompt: string[], options: PromptOptions, command: Command) => { if (prompt.length === 0) { program.help(); return; } let effective: PromptOptions = { ...(command.opts() as PromptOptions), ...options }; const provider = rawOption("--provider"); const model = rawOption("--model"); const risk = rawOption("--risk"); if (provider) effective = { ...effective, provider }; if (model) effective = { ...effective, model }; if (risk) effective = { ...effective, risk: risk as NonNullable<PromptOptions["risk"]> }; await runProject(prompt.join(" "), effective); });

program.command("run").description("Run a prompt in the current Git project or an objective YAML file.").argument("[input...]", "prompt or legacy objective YAML path")
  .option("--objective-file <path>", "explicit objective YAML path").option("--provider <provider>").option("--model <model>").option("--risk <risk>")
  .action(async (input: string[], options: PromptOptions & { objectiveFile?: string }, command: Command) => { let effective: PromptOptions & { objectiveFile?: string } = { ...(command.opts() as PromptOptions & { objectiveFile?: string }), ...options }; const provider = rawOption("--provider"); const model = rawOption("--model"); const risk = rawOption("--risk"); if (provider) effective = { ...effective, provider }; if (model) effective = { ...effective, model }; if (risk) effective = { ...effective, risk: risk as NonNullable<PromptOptions["risk"]> }; if (input.length === 0 && !effective.objectiveFile) throw new Error("Provide an objective prompt or --objective-file <path>."); await runInput(input, effective); });

program.command("resume").description("Resume an interrupted run.").argument("<runId>").option("--provider <provider>").option("--model <model>")
  .action(async (runId: string, options: ProviderOptions, command: Command) => {
    const effective: ProviderOptions = { ...(command.opts() as ProviderOptions), ...options };
    const provider = rawOption("--provider");
    const model = rawOption("--model");
    if (provider) effective.provider = provider;
    if (model) effective.model = model;
    const runtime = existsSync(path.join(cwd(), ".agent-org", "state", "runs", runId)) ? await legacyRuntime(cwd(), effective) : (await projectSetup(effective)).runtime;
    console.log(JSON.stringify(completedSummary(await runtime.resume(runId)), null, 2));
  });

program.command("status").option("--run <runId>").action(async (options: { run?: string }) => { const selected = await selectedStore(options.run); const ledger = await selected.store.load(selected.runId); console.log(JSON.stringify({ revision: ledger.revision, ...summary(ledger) }, null, 2)); });
program.command("runs").action(async () => { const selected = await selectedStore(); const rows = await Promise.all((await selected.store.listRuns()).map(async (id) => summary(await selected.store.load(id)))); console.table(rows.map((row) => ({ runId: row.runId, lifecycle: row.lifecycle, objective: row.objective, task: row.task, branch: row.branch ?? "-", provider: (row.providers as string[]).join(","), model: (row.models as string[]).join(","), rework: row.rework }))); });
program.command("tasks").option("--run <runId>").action(async (options: { run?: string }) => { const selected = await selectedStore(options.run); const ledger = await selected.store.load(selected.runId); console.table(ledger.tasks.map((task) => ({ id: task.id, status: task.status, implementer: task.implementerId ?? "-", tester: task.verifierId ?? "-", reviewer: task.reviewerId ?? "-", iteration: task.iteration ?? 0, rework: task.reworkCount }))); });
program.command("inspect").argument("<taskId>").option("--run <runId>").action(async (taskId: string, options: { run?: string }) => { const selected = await selectedStore(options.run); const ledger = await selected.store.load(selected.runId); const task = ledger.tasks.find((item) => item.id === taskId); if (!task) throw new Error(`Task ${taskId} does not exist in ${selected.runId}.`); console.log(JSON.stringify({ task, results: ledger.results.filter((item) => item.taskId === task.id), verifications: ledger.verifications.filter((item) => item.taskId === task.id), reviews: ledger.reviews.filter((item) => item.taskId === task.id), agentRuns: ledger.agentRuns.filter((item) => item.taskId === task.id), receipts: ledger.receipts.filter((item) => item.taskId === task.id), artifacts: ledger.artifacts.filter((item) => task.artifactIds.includes(item.id)) }, null, 2)); });
for (const collection of ["reviews", "decisions"] as const) program.command(collection).option("--run <runId>").action(async (options: { run?: string }) => { const selected = await selectedStore(options.run); console.log(JSON.stringify((await selected.store.load(selected.runId))[collection], null, 2)); });
program.command("events").option("--run <runId>").action(async (options: { run?: string }) => { const selected = await selectedStore(options.run); console.table((await selected.store.events(selected.runId)).map((event, index) => ({ revision: index + 1, timestamp: event.timestamp, type: event.type, actor: event.actorId, task: event.taskId ?? "-" }))); });
program.command("diff").option("--run <runId>").description("Show the Git diff for a completed or interrupted run.").action(async (options: { run?: string }) => { const selected = await selectedStore(options.run); const ledger = await selected.store.load(selected.runId); const workspace = ledger.preparedWorkspace?.path ?? selected.store.workspaceDirectory(selected.runId); const result = await execFileAsync("git", ["--no-pager", "diff", "--no-ext-diff"], { cwd: workspace, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); });
program.command("doctor").description("Check local Agent Org project prerequisites without calling a provider.").action(async () => { const checks: Array<{ check: string; status: "PASS" | "FAIL"; detail: string }> = []; try { const paths = await resolveProjectModePaths(cwd()); checks.push({ check: "Git repository", status: "PASS", detail: paths.projectRoot }); const projectConfiguration = await loadProjectConfiguration(paths.projectRoot, paths.agentOrgHome); const commands = await discoverProjectCommands(paths.projectRoot, projectConfiguration); checks.push({ check: "Project command discovery", status: commands.length > 0 ? "PASS" : "FAIL", detail: commands.map((command) => command.id).join(", ") || "No supported test/typecheck scripts found" }); const configuration = await loadGlobalConfiguration(paths.agentOrgHome, paths.runtimeStateRoot); const openaiSelected = Object.values(configuration.organization.providers).some((provider) => provider.type === "openai"); checks.push({ check: "Provider configuration", status: openaiSelected ? "PASS" : "FAIL", detail: openaiSelected ? "OpenAI configured" : "No OpenAI provider configured" }); checks.push({ check: "API credential present", status: !openaiSelected || Boolean(process.env.OPENAI_API_KEY) ? "PASS" : "FAIL", detail: !openaiSelected ? "Not required" : process.env.OPENAI_API_KEY ? "OPENAI_API_KEY is set" : "Set OPENAI_API_KEY before live runs" }); checks.push({ check: "Writable Agent Org state", status: "PASS", detail: paths.runtimeStateRoot }); } catch (error) { checks.push({ check: "Project setup", status: "FAIL", detail: error instanceof Error ? error.message : String(error) }); } console.table(checks); });

program.command("eval").argument("<directory>").action(async (directory: string) => {
  const root = cwd(); const caseFiles = (await readdir(path.resolve(root, directory), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, directory, entry.name, "case.json")).filter(existsSync).sort();
  const configuration = await loadConfiguration(root); const store = new FileBlackboard(configuration.stateDirectory); const results: Array<Record<string, unknown>> = [];
  for (const file of caseFiles) {
    const definition = JSON.parse(await readFile(file, "utf8")) as { name: string; objective: string; mock?: MockProviderOptions; expectFailure?: boolean; expectations: unknown }; let failure: string | undefined; let run: string | undefined;
    try { run = (await (await legacyRuntime(root, { provider: "mock", ...(definition.mock ? { mock: definition.mock } : {}) })).run(await loadObjective(path.resolve(root, definition.objective)))).runId; } catch (error) { failure = error instanceof Error ? error.message : String(error); run = await store.latestRunId(); }
    const evaluated = evaluateLedger(await store.load(run), await store.events(run), EvalExpectationsSchema.parse(definition.expectations)); const passed = evaluated.passed && Boolean(failure) === (definition.expectFailure ?? false); results.push({ name: definition.name, runId: run, passed, failure: failure ?? "-", assertions: evaluated.assertions });
  }
  console.table(results.map((result) => ({ name: result.name, runId: result.runId, passed: result.passed, failure: result.failure }))); if (results.some((result) => !result.passed)) throw new Error("One or more deterministic evaluations failed.");
});

try { await program.parseAsync(process.argv); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
