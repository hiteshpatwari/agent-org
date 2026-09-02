import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProviderExecutionError, type AgentExecutionRequest, type AgentProvider, type ProviderSession, type ProviderTurnResult } from "@agent-org/core";
import { MockProvider } from "@agent-org/providers";
import { FileBlackboard, OrganizationRuntime, loadConfiguration, loadObjective, requiredCapabilities } from "@agent-org/runtime";
import { LocalToolRegistry, LocalWorkspaceManager } from "@agent-org/tools";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

class FailFirstDeveloperProvider implements AgentProvider {
  public readonly id = "mock";
  private readonly base = new MockProvider();
  private failed = false;
  public capabilities = (): ReturnType<MockProvider["capabilities"]> => this.base.capabilities();
  public createSession = async (...args: Parameters<MockProvider["createSession"]>): Promise<ProviderSession> => await this.base.createSession(...args);
  public async execute(session: ProviderSession, request: AgentExecutionRequest, options?: { signal?: AbortSignal }): Promise<ProviderTurnResult> {
    if (request.role === "DEVELOPER" && !this.failed) {
      this.failed = true;
      throw new ProviderExecutionError({ code: "NETWORK", message: "scripted crash", retryable: true, providerId: this.id });
    }
    void options;
    return await this.base.execute(session, request);
  }
  public closeSession = async (session: ProviderSession): Promise<void> => await this.base.closeSession(session);
}

async function setup(provider: AgentProvider): Promise<{ runtime: OrganizationRuntime; store: FileBlackboard; state: string }> {
  const state = await mkdtemp(path.join(os.tmpdir(), "agent-org-v1-"));
  temporaryDirectories.push(state);
  const configuration = await loadConfiguration(root);
  const store = new FileBlackboard(state);
  return {
    state,
    store,
    runtime: new OrganizationRuntime({
      repositoryRoot: root,
      stateDirectory: state,
      agents: configuration.agents,
      requiredCapabilities: requiredCapabilities(configuration),
      provider,
      tools: new LocalToolRegistry([
        { id: "sample-test", description: "sample tests", executable: process.execPath, args: ["--test", "test/sum.test.mjs"], timeoutMs: 30_000 },
        { id: "real-bug-test", description: "bug tests", executable: process.execPath, args: ["--experimental-strip-types", "--test", "test/order.test.mjs"], timeoutMs: 30_000 },
      ]),
      workspaceManager: new LocalWorkspaceManager(),
      blackboard: store,
      maxRework: 2,
      executorOptions: { maxRetries: 0, retryBackoffMs: 0 },
    }),
  };
}

describe("V1 durable orchestration", () => {
  it("derives implementation write evidence when the developer omits receipt IDs", async () => {
    const fixture = await setup(new MockProvider({ omitImplementationEvidence: true }));
    const completed = await fixture.runtime.run(await loadObjective(path.join(root, "examples", "simple-feature", "objective.yaml")));
    expect(completed.ledger.lifecycle).toBe("COMPLETED");
    const result = completed.ledger.results[0];
    expect(result?.evidenceReceiptIds.length).toBeGreaterThan(0);
    expect(completed.ledger.receipts.filter((receipt) => receipt.toolName === "filesystem.write")).not.toHaveLength(0);
  }, 30_000);

  it("executes bounded reviewer rejection, rework, re-verification, and latest-state acceptance", async () => {
    const fixture = await setup(new MockProvider({ reviewDecisions: ["REQUEST_CHANGES", "APPROVE"] }));
    const completed = await fixture.runtime.run(await loadObjective(path.join(root, "examples", "simple-feature", "objective.yaml")));
    const ledger = await fixture.store.load(completed.runId);
    const task = ledger.tasks[0];
    expect(task).toMatchObject({ status: "COMPLETED", reworkCount: 1, iteration: 1 });
    expect(ledger.reviews.map((item) => item.decision)).toEqual(["REQUEST_CHANGES", "APPROVE"]);
    expect(ledger.verifications).toHaveLength(2);
    expect(ledger.results).toHaveLength(2);
    const currentVerification = ledger.verifications.find((item) => item.id === task?.verificationId);
    const currentReview = ledger.reviews.find((item) => item.id === task?.reviewId);
    expect(currentVerification).toMatchObject({ iteration: 1, workspaceStateHash: task?.workspaceStateHash });
    expect(currentReview).toMatchObject({ iteration: 1, workspaceStateHash: task?.workspaceStateHash });
    expect((await fixture.store.events(completed.runId)).some((event) => event.type === "REWORK_STARTED")).toBe(true);
  }, 30_000);

  it("resumes the same workspace and stage after a provider crash without repeating Chief planning", async () => {
    const first = await setup(new FailFirstDeveloperProvider());
    const objective = await loadObjective(path.join(root, "examples", "simple-feature", "objective.yaml"));
    await expect(first.runtime.run(objective)).rejects.toThrow("scripted crash");
    const runId = await first.store.latestRunId();
    expect((await first.store.load(runId)).lifecycle).toBe("INTERRUPTED");

    const configuration = await loadConfiguration(root);
    const resumed = new OrganizationRuntime({
      repositoryRoot: root,
      stateDirectory: first.state,
      agents: configuration.agents,
      requiredCapabilities: requiredCapabilities(configuration),
      provider: new MockProvider(),
      tools: new LocalToolRegistry([{ id: "sample-test", description: "sample tests", executable: process.execPath, args: ["--test", "test/sum.test.mjs"], timeoutMs: 30_000 }]),
      workspaceManager: new LocalWorkspaceManager(),
      blackboard: first.store,
      maxRework: 2,
      executorOptions: { maxRetries: 0, retryBackoffMs: 0 },
    });
    const completed = await resumed.resume(runId);
    expect(completed.ledger.lifecycle).toBe("COMPLETED");
    expect(completed.ledger.agentRuns.filter((run) => run.role === "CHIEF_ENGINEER")).toHaveLength(1);
    expect(completed.ledger.agentRuns.filter((run) => run.role === "DEVELOPER").map((run) => run.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect((await first.store.events(runId)).some((event) => event.type === "RUN_RESUMED")).toBe(true);
  }, 30_000);
});
