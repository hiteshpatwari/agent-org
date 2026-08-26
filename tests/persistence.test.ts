import { readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FileArtifactStore, FileBlackboard, StorageConflictError, StorageIntegrityError } from "@agent-org/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { ledger } from "./helpers.js";

const temporaryDirectories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-org-storage-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("filesystem blackboard", () => {
  it("persists snapshots and an append-only chronological event journal", async () => {
    const state = await temporary();
    const store = new FileBlackboard(state);
    const created = await store.createRun(ledger(), {
      type: "OBJECTIVE_CREATED",
      actorId: "chief",
    });
    const committed = await store.commit(
      "RUN-1",
      created.revision,
      { ...created, objective: { ...created.objective, title: "Updated" } },
      { type: "TASK_CREATED", actorId: "chief", taskId: "TASK-1" },
    );
    expect(committed.revision).toBe(2);
    expect((await store.load("RUN-1")).objective.title).toBe("Updated");
    expect((await store.events("RUN-1")).map((event) => event.type)).toEqual([
      "OBJECTIVE_CREATED",
      "TASK_CREATED",
    ]);
    await expect(store.commit("RUN-1", 1, committed, { type: "TASK_READY", actorId: "chief" })).rejects.toBeInstanceOf(
      StorageConflictError,
    );
  });

  it("repairs a missing or stale snapshot from the authoritative journal", async () => {
    const state = await temporary();
    const store = new FileBlackboard(state);
    await store.createRun(ledger(), { type: "OBJECTIVE_CREATED", actorId: "chief" });
    const snapshot = path.join(store.runDirectory("RUN-1"), "ledger.json");
    await writeFile(snapshot, "{}\n", "utf8");
    const recovered = await store.load("RUN-1");
    expect(recovered.revision).toBe(1);
    expect(JSON.parse(await readFile(snapshot, "utf8"))).toMatchObject({ revision: 1, runId: "RUN-1" });
  });

  it("detects journal tampering and revision/hash mismatch", async () => {
    const state = await temporary();
    const store = new FileBlackboard(state);
    await store.createRun(ledger(), { type: "OBJECTIVE_CREATED", actorId: "chief" });
    const journal = path.join(store.runDirectory("RUN-1"), "events.jsonl");
    const entry = JSON.parse((await readFile(journal, "utf8")).trim()) as {
      state: { objective: { title: string } };
    };
    entry.state.objective.title = "tampered";
    await writeFile(journal, `${JSON.stringify(entry)}\n`, "utf8");
    await expect(store.load("RUN-1")).rejects.toBeInstanceOf(StorageIntegrityError);
  });

  it("rejects concurrent writers for the same run", async () => {
    const state = await temporary();
    const store = new FileBlackboard(state);
    await store.createRun(ledger(), { type: "OBJECTIVE_CREATED", actorId: "chief" });
    const release = await store.acquireRunLock("RUN-1");
    await expect(store.acquireRunLock("RUN-1")).rejects.toBeInstanceOf(StorageConflictError);
    await release();
    const releaseAgain = await store.acquireRunLock("RUN-1");
    await releaseAgain();
  });

  it("verifies a V0 raw hash before applying additive V1 schema defaults", async () => {
    const state = await temporary();
    const store = new FileBlackboard(state);
    await store.createRun(ledger(), { type: "OBJECTIVE_CREATED", actorId: "chief" });
    const journal = path.join(store.runDirectory("RUN-1"), "events.jsonl");
    const entry = JSON.parse((await readFile(journal, "utf8")).trim()) as { stateHash: string; state: { objective: Record<string, unknown> } };
    delete entry.state.objective.contextFiles;
    delete entry.state.objective.verificationCommandIds;
    entry.stateHash = createHash("sha256").update(JSON.stringify(entry.state)).digest("hex");
    await writeFile(journal, `${JSON.stringify(entry)}\n`, "utf8");
    const recovered = await store.load("RUN-1");
    expect(recovered.objective.contextFiles).toEqual([]);
    expect(recovered.objective.verificationCommandIds).toEqual([]);
  });
});

describe("artifact integrity", () => {
  it("stores content-addressed artifacts and detects tampering", async () => {
    const state = await temporary();
    const store = new FileBlackboard(state);
    await store.createRun(ledger(), { type: "OBJECTIVE_CREATED", actorId: "chief" });
    const artifacts = new FileArtifactStore(store);
    const artifact = await artifacts.create({
      runId: "RUN-1",
      taskId: "TASK-1",
      type: "TEST_REPORT",
      title: "Test report",
      mediaType: "application/json",
      content: "{\"pass\":true}\n",
      createdBy: "tester",
    });
    await expect(artifacts.verify(artifact)).resolves.toBeUndefined();
    await writeFile(path.join(store.runDirectory("RUN-1"), artifact.path), "tampered", "utf8");
    await expect(artifacts.verify(artifact)).rejects.toThrow(/integrity/u);
  });

  it("redacts secret-shaped content before artifact persistence", async () => {
    const state = await temporary();
    const store = new FileBlackboard(state);
    await store.createRun(ledger(), { type: "OBJECTIVE_CREATED", actorId: "chief" });
    const fakeKey = ["sk", "proj", "secretvalue123"].join("-");
    const artifact = await new FileArtifactStore(store).create({ runId: "RUN-1", type: "INVESTIGATION", title: "safe", mediaType: "text/markdown", content: `key=${fakeKey}`, createdBy: "chief" });
    const content = await readFile(path.join(store.runDirectory("RUN-1"), artifact.path), "utf8");
    expect(content).not.toContain(fakeKey);
    expect(content).toContain("[REDACTED]");
  });
});
