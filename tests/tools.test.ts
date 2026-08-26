import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AuthorizationError } from "@agent-org/core";
import { LocalToolRegistry } from "@agent-org/tools";
import { afterEach, describe, expect, it } from "vitest";

import { principal } from "./helpers.js";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-org-tools-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("permission-enforcing local tools", () => {
  it("writes and reads only through declared capabilities", async () => {
    const root = await workspace();
    const registry = new LocalToolRegistry();
    const actor = principal("DEVELOPER", "developer");
    const written = await registry.execute(actor, root, ["filesystem.write"], {
      id: "write",
      name: "filesystem.write",
      input: { path: "src/example.ts", content: "export const value = 1;\n" },
    });
    expect(written.receipt.status).toBe("SUCCEEDED");
    expect(written.receipt.contentHashes["src/example.ts"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(written.receipt.input).not.toHaveProperty("content");
    expect(written.receipt.input).toMatchObject({ path: "src/example.ts", bytes: 24 });
    await expect(
      registry.execute(actor, root, ["filesystem.write"], {
        id: "read",
        name: "filesystem.read",
        input: { path: "src/example.ts" },
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("rejects traversal and junction/symlink escape", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    const registry = new LocalToolRegistry();
    const actor = principal("DEVELOPER", "developer");
    const traversal = await registry.execute(actor, root, ["filesystem.read"], {
      id: "traversal",
      name: "filesystem.read",
      input: { path: "../secret.txt" },
    });
    expect(traversal.receipt.status).toBe("FAILED");
    await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const linked = await registry.execute(actor, root, ["filesystem.read"], {
      id: "linked",
      name: "filesystem.read",
      input: { path: "escape/secret.txt" },
    });
    expect(linked.receipt.status).toBe("FAILED");
  });

  it("uses exact command templates, rejects injected command IDs, and enforces timeouts", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "test"), { recursive: true });
    const registry = new LocalToolRegistry([
      {
        id: "ok",
        description: "fixed safe command",
        executable: process.execPath,
        args: ["-e", "console.log('ok')"],
        timeoutMs: 5_000,
      },
      {
        id: "slow",
        description: "timeout fixture",
        executable: process.execPath,
        args: ["-e", "setTimeout(() => {}, 5000)"],
        timeoutMs: 20,
      },
    ]);
    const actor = principal("TESTER", "tester");
    const ok = await registry.execute(actor, root, ["shell.execute"], {
      id: "ok-call",
      name: "shell.execute",
      input: { commandId: "ok" },
    });
    expect(ok.receipt).toMatchObject({ status: "SUCCEEDED", exitCode: 0 });
    const injected = await registry.execute(actor, root, ["shell.execute"], {
      id: "bad-call",
      name: "shell.execute",
      input: { commandId: "ok; whoami" },
    });
    expect(injected.receipt.status).toBe("FAILED");
    const timedOut = await registry.execute(actor, root, ["shell.execute"], {
      id: "slow-call",
      name: "shell.execute",
      input: { commandId: "slow" },
    });
    expect(timedOut.receipt.status).toBe("FAILED");
    expect(JSON.stringify(timedOut.receipt.output)).toMatch(/timed out/u);
  });

  it("redacts secret-shaped values from tool errors", async () => {
    const root = await workspace();
    const registry = new LocalToolRegistry();
    const fakeKey = ["sk", "secretvalue123456"].join("-");
    const result = await registry.execute(principal("TESTER", "tester"), root, ["shell.execute"], {
      id: "secret",
      name: "shell.execute",
      input: { commandId: `OPENAI_API_KEY=${fakeKey}` },
    });
    expect(JSON.stringify(result.receipt.output)).not.toContain(fakeKey);
    expect(JSON.stringify(result.receipt.output)).toContain("[REDACTED]");
  });

  it("denies sensitive files and provides bounded literal repository search", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "example.ts"), "export const needle = 1;\n", "utf8");
    const fakeProjectKey = ["sk", "proj", "secretvalue123"].join("-");
    await writeFile(path.join(root, ".env.local"), `OPENAI_API_KEY=${fakeProjectKey}\n`, "utf8");
    const registry = new LocalToolRegistry();
    const actor = principal("DEVELOPER", "developer");
    const sensitive = await registry.execute(actor, root, ["filesystem.read"], { id: "sensitive", name: "filesystem.read", input: { path: ".env.local" } });
    expect(sensitive.receipt.status).toBe("FAILED");
    const search = await registry.execute(actor, root, ["repository.search"], { id: "search", name: "repository.search", input: { query: "needle" } });
    expect(search.receipt.status).toBe("SUCCEEDED");
    expect(search.receipt.output).toMatchObject({ matches: [{ path: "src/example.ts", line: 1 }] });
    expect(JSON.stringify(search.receipt.output)).not.toContain(fakeProjectKey);
  });
});
