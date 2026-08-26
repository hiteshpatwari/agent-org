import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { MockProvider } from "@agent-org/providers";
import {
  FileBlackboard,
  OrganizationRuntime,
  loadConfiguration,
  loadObjective,
  requiredCapabilities,
} from "@agent-org/runtime";
import { LocalToolRegistry, LocalWorkspaceManager } from "@agent-org/tools";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("deterministic organization workflow", () => {
  it("implements, tests, reviews, accepts, and leaves inspectable evidence", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "agent-org-e2e-"));
    temporaryDirectories.push(state);
    const configuration = await loadConfiguration(root);
    const objective = await loadObjective(path.join(root, "examples", "simple-feature", "objective.yaml"));
    const store = new FileBlackboard(state);
    const runtime = new OrganizationRuntime({
      repositoryRoot: root,
      stateDirectory: state,
      agents: configuration.agents,
      requiredCapabilities: requiredCapabilities(configuration),
      provider: new MockProvider(),
      tools: new LocalToolRegistry([
        {
          id: "sample-test",
          description: "sample tests",
          executable: process.execPath,
          args: ["--test", "test/sum.test.mjs"],
          timeoutMs: 30_000,
        },
      ]),
      workspaceManager: new LocalWorkspaceManager(),
      blackboard: store,
    });

    const completed = await runtime.run(objective);
    const loaded = await store.load(completed.runId);
    const task = loaded.tasks[0];
    expect(loaded.objective.status).toBe("COMPLETED");
    expect(task?.status).toBe("COMPLETED");
    expect(task?.implementerId).toBe("developer");
    expect(task?.verifierId).toBe("tester");
    expect(task?.reviewerId).toBe("reviewer");
    expect(loaded.verifications[0]?.decision).toBe("PASS");
    expect(loaded.reviews[0]?.decision).toBe("APPROVE");
    expect(loaded.reviews[0]?.reviewerId).not.toBe(task?.implementerId);
    expect(loaded.receipts.some((receipt) => receipt.toolName === "shell.execute" && receipt.exitCode === 0)).toBe(true);
    expect(
      loaded.receipts.some(
        (receipt) =>
          receipt.toolName === "git.diff" &&
          typeof receipt.output === "object" &&
          receipt.output !== null &&
          "stdout" in receipt.output &&
          typeof receipt.output.stdout === "string" &&
          receipt.output.stdout.includes("src/sum.ts"),
      ),
    ).toBe(true);
    expect(loaded.agentRuns).toHaveLength(4);
    expect(loaded.agentRuns[0]?.role).toBe("CHIEF_ENGINEER");
    expect(loaded.agentRuns.every((run) => run.status === "SUCCEEDED")).toBe(true);
    expect(loaded.artifacts).toHaveLength(4);

    const implementation = await readFile(path.join(completed.workspaceDirectory, "src", "sum.ts"), "utf8");
    expect(implementation).toContain("return a + b");
    const diff = await execFileAsync("git", ["diff", "--", "src/sum.ts"], {
      cwd: completed.workspaceDirectory,
      windowsHide: true,
    });
    expect(diff.stdout).toContain("return a + b");

    const events = await store.events(completed.runId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "OBJECTIVE_CREATED",
        "TASK_CREATED",
        "IMPLEMENTATION_SUBMITTED",
        "TEST_COMPLETED",
        "REVIEW_COMPLETED",
        "TASK_COMPLETED",
        "OBJECTIVE_COMPLETED",
      ]),
    );
    expect(events).toHaveLength(loaded.revision);
  }, 30_000);
});
