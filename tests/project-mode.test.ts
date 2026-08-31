import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ObjectiveBuilder, discoverGitRoot, discoverProjectCommands, discoverProjectContextFiles, loadProjectConfiguration, resolveProjectModePaths } from "@agent-org/runtime";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repositoryRoot, "packages", "cli", "dist", "index.js");
const cleanup: Array<() => Promise<void>> = [];

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout.trim();
}

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-org-project-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "src", "sum.ts"), "export function sum(a: number, b: number): number { return a - b; }\n");
  await writeFile(path.join(root, "test", "sum.test.mjs"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { sum } from '../src/sum.ts';\ntest('adds', () => assert.equal(sum(2, 3), 5));\n");
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "temporary-project", private: true, packageManager: "npm@11.0.0", scripts: { test: "node --test test/sum.test.mjs", unsafe: "echo never-discovered" } }, null, 2)}\n`);
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify({ name: "temporary-project", lockfileVersion: 3, packages: { "": { name: "temporary-project" } } }, null, 2)}\n`);
  await writeFile(path.join(root, "README.md"), "# Temporary project\n");
  await writeFile(path.join(root, "AGENTS.md"), "Project guidance only.\n");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["add", "--all"]);
  await git(root, ["-c", "user.name=Agent Org Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"]);
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation();
});

describe("current project mode", () => {
  it("discovers nested Git roots, safe context, package manager, commands, and a validated Objective", async () => {
    const root = await temporaryProject();
    const nested = path.join(root, "src");
    expect(await discoverGitRoot(nested)).toBe(await discoverGitRoot(root));
    const configuration = await loadProjectConfiguration(root);
    const commands = await discoverProjectCommands(root, configuration);
    expect(commands.map((command) => command.id)).toEqual(["project.test"]);
    expect(commands[0]).toMatchObject({ packageManager: "npm" });
    expect(commands[0]?.args.at(-1)).toContain("test");
    expect(discoverProjectContextFiles(root)).toEqual(["AGENTS.md", "README.md", "package.json"]);
    expect(new ObjectiveBuilder().build({ prompt: "Fix addition", projectRoot: root, contextFiles: ["AGENTS.md"], verificationCommandIds: ["project.test"] })).toMatchObject({ description: "Fix addition", workspaceTemplate: root, verificationCommandIds: ["project.test"] });
  });

  it("applies project settings over global defaults and excludes configured secret context", async () => {
    const root = await temporaryProject();
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-org-home-"));
    cleanup.push(async () => { await rm(home, { recursive: true, force: true }); });
    await writeFile(path.join(home, "project-defaults.yaml"), "risk:\n  default: LOW\ncontext:\n  include:\n    - PRODUCT.md\n");
    await writeFile(path.join(root, ".agent-org.yaml"), "risk:\n  default: HIGH\ncontext:\n  include:\n    - README.md\n    - .env.local\n");
    await writeFile(path.join(root, ".env.local"), "SECRET=never-read\n");
    const configuration = await loadProjectConfiguration(root, home);
    expect(configuration).toMatchObject({ risk: { default: "HIGH" }, context: { include: ["README.md", ".env.local"] } });
    expect(discoverProjectContextFiles(root, configuration.context.include)).toEqual(["AGENTS.md", "README.md", "package.json"]);
  });

  it("runs from a nested directory, preserves the original tree, and reports an isolated resumable worktree", async () => {
    const root = await temporaryProject();
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-org-home-"));
    cleanup.push(async () => { await rm(home, { recursive: true, force: true }); });
    const original = await readFile(path.join(root, "src", "sum.ts"), "utf8");
    const execution = await execFileAsync(process.execPath, [cli, "Implement the requested feature", "--provider", "mock"], {
      cwd: path.join(root, "src"),
      env: { ...process.env, AGENT_ORG_HOME: home },
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(execution.stdout) as { runId: string; lifecycle: string; branch: string; worktree: string; projectRoot: string; changedFiles: string[]; verification: string; review: string };
    cleanup.push(async () => { await git(root, ["worktree", "remove", "--force", result.worktree]); });
    expect(result).toMatchObject({ lifecycle: "COMPLETED", projectRoot: await discoverGitRoot(root), verification: "PASS", review: "APPROVE" });
    expect(result.branch).toBe(`agent-org/${result.runId.toLowerCase()}`);
    expect(result.changedFiles).toContain("src/sum.ts");
    expect(await readFile(path.join(root, "src", "sum.ts"), "utf8")).toBe(original);
    expect(await readFile(path.join(result.worktree, "src", "sum.ts"), "utf8")).toContain("return a + b");
    expect(await git(root, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    const paths = await resolveProjectModePaths(root, { ...process.env, AGENT_ORG_HOME: home });
    const ledger = JSON.parse(await readFile(path.join(paths.runtimeStateRoot, "runs", result.runId, "ledger.json"), "utf8")) as {
      objective: { description: string };
      tasks: Array<{ implementerId: string; verifierId: string; reviewerId: string; iteration: number; workspaceStateHash: string; verificationId: string; reviewId: string }>;
      agentRuns: Array<{ role: string }>;
      receipts: Array<{ agentId: string; toolName: string }>;
      verifications: Array<{ id: string; testerId: string; iteration: number; workspaceStateHash: string }>;
      reviews: Array<{ id: string; reviewerId: string; iteration: number; workspaceStateHash: string }>;
      preparedWorkspace: { branch: string };
    };
    expect(ledger.objective.description).toBe("Implement the requested feature");
    expect(ledger.agentRuns.map((run) => run.role)).toEqual(["CHIEF_ENGINEER", "DEVELOPER", "TESTER", "REVIEWER"]);
    expect(ledger.preparedWorkspace.branch).toBe(result.branch);
    const task = ledger.tasks[0]!;
    expect(new Set([task.implementerId, task.verifierId, task.reviewerId]).size).toBe(3);
    expect(ledger.receipts.filter((receipt) => [task.verifierId, task.reviewerId].includes(receipt.agentId) && receipt.toolName === "filesystem.write")).toEqual([]);
    expect(ledger.verifications.find((verification) => verification.id === task.verificationId)).toMatchObject({ testerId: task.verifierId, iteration: task.iteration, workspaceStateHash: task.workspaceStateHash });
    expect(ledger.reviews.find((review) => review.id === task.reviewId)).toMatchObject({ reviewerId: task.reviewerId, iteration: task.iteration, workspaceStateHash: task.workspaceStateHash });
    const resumed = await execFileAsync(process.execPath, [cli, "resume", result.runId, "--provider", "mock"], { cwd: root, env: { ...process.env, AGENT_ORG_HOME: home }, windowsHide: true, timeout: 30_000 });
    expect((JSON.parse(resumed.stdout) as { runId: string; lifecycle: string })).toMatchObject({ runId: result.runId, lifecycle: "COMPLETED" });
  }, 90_000);

  it("rejects a dirty working tree without creating a worktree", async () => {
    const root = await temporaryProject();
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-org-home-"));
    cleanup.push(async () => { await rm(home, { recursive: true, force: true }); });
    await writeFile(path.join(root, "dirty.txt"), "uncommitted\n");
    await expect(execFileAsync(process.execPath, [cli, "Do work", "--provider", "mock"], { cwd: root, env: { ...process.env, AGENT_ORG_HOME: home }, windowsHide: true, timeout: 30_000 })).rejects.toMatchObject({ stderr: expect.stringContaining("uncommitted changes") });
    expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain("agent-org/");
  }, 40_000);
});
