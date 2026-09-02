import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { appendFile, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  DomainEventSchema,
  JournalEntrySchema,
  LedgerSchema,
  type DomainEvent,
  type DomainEventType,
  type JournalEntry,
  type Ledger,
} from "@agent-org/core";

export class StorageConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StorageConflictError";
  }
}

export class StorageIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StorageIntegrityError";
  }
}

export interface EventInput {
  type: DomainEventType;
  actorId: string;
  taskId?: string;
  data?: Record<string, unknown>;
}

export interface BlackboardStore {
  createRun(initial: Ledger, event: EventInput): Promise<Ledger>;
  load(runId: string): Promise<Ledger>;
  commit(runId: string, expectedRevision: number, next: Ledger, event: EventInput): Promise<Ledger>;
  events(runId: string): Promise<DomainEvent[]>;
  latestRunId(): Promise<string>;
  runDirectory(runId: string): string;
  workspaceDirectory(runId: string): string;
  listRuns(): Promise<string[]>;
  acquireRunLock(runId: string): Promise<() => Promise<void>>;
}

function stateHash(state: Ledger): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function makeEvent(runId: string, input: EventInput): DomainEvent {
  return DomainEventSchema.parse({
    id: `EVT-${randomUUID()}`,
    runId,
    type: input.type,
    actorId: input.actorId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    timestamp: new Date().toISOString(),
    data: input.data ?? {},
  });
}

export class FileBlackboard implements BlackboardStore {
  public constructor(private readonly stateDirectory: string) {}

  public runDirectory(runId: string): string {
    return path.join(this.stateDirectory, "runs", runId);
  }

  public workspaceDirectory(runId: string): string {
    return path.join(this.runDirectory(runId), "workspace");
  }

  private journalPath(runId: string): string {
    return path.join(this.runDirectory(runId), "events.jsonl");
  }

  private snapshotPath(runId: string): string {
    return path.join(this.runDirectory(runId), "ledger.json");
  }

  private async writeSnapshot(runId: string, ledger: Ledger): Promise<void> {
    const target = this.snapshotPath(runId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private async appendEntry(runId: string, entry: JournalEntry): Promise<void> {
    await appendFile(this.journalPath(runId), `${JSON.stringify(entry)}\n`, "utf8");
  }

  public async createRun(initial: Ledger, eventInput: EventInput): Promise<Ledger> {
    const directory = this.runDirectory(initial.runId);
    if (existsSync(directory)) throw new StorageConflictError(`Run ${initial.runId} already exists.`);
    await mkdir(path.join(directory, "artifacts"), { recursive: true });
    const now = new Date().toISOString();
    const state = LedgerSchema.parse({ ...initial, revision: 1, updatedAt: now });
    const entry = JournalEntrySchema.parse({
      revision: 1,
      previousRevision: 0,
      stateHash: stateHash(state),
      event: makeEvent(initial.runId, eventInput),
      state,
    });
    await this.appendEntry(initial.runId, entry);
    await this.writeSnapshot(initial.runId, state);
    await mkdir(this.stateDirectory, { recursive: true });
    await writeFile(
      path.join(this.stateDirectory, "latest.json"),
      `${JSON.stringify({ runId: initial.runId })}\n`,
      "utf8",
    );
    return state;
  }

  private async readJournal(runId: string): Promise<JournalEntry[]> {
    let content: string;
    try {
      content = await readFile(this.journalPath(runId), "utf8");
    } catch (error) {
      throw new StorageIntegrityError(`Cannot read journal for ${runId}: ${String(error)}.`);
    }
    const lines = content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    if (lines.length === 0) throw new StorageIntegrityError(`Journal for ${runId} is empty.`);
    const entries = lines.map((line, index) => {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const rawState = raw.state;
        if (typeof raw.stateHash !== "string" || raw.stateHash !== stateHash(rawState as Ledger)) {
          throw new Error("Stored state hash does not match raw journal state.");
        }
        return JournalEntrySchema.parse(raw);
      } catch (error) {
        throw new StorageIntegrityError(`Invalid journal entry ${index + 1} for ${runId}: ${String(error)}.`);
      }
    });
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) throw new StorageIntegrityError(`Missing journal entry ${index + 1}.`);
      const expectedRevision = index + 1;
      if (
        entry.revision !== expectedRevision ||
        entry.previousRevision !== expectedRevision - 1 ||
        entry.state.revision !== expectedRevision
      ) {
        throw new StorageIntegrityError(`Journal revision chain is invalid at revision ${expectedRevision}.`);
      }
    }
    return entries;
  }

  public async load(runId: string): Promise<Ledger> {
    const entries = await this.readJournal(runId);
    const authoritative = entries.at(-1)?.state;
    if (!authoritative) throw new StorageIntegrityError(`Run ${runId} has no authoritative state.`);
    let snapshotCurrent: boolean;
    try {
      const snapshot = LedgerSchema.parse(JSON.parse(await readFile(this.snapshotPath(runId), "utf8")));
      snapshotCurrent =
        snapshot.revision === authoritative.revision && stateHash(snapshot) === stateHash(authoritative);
    } catch {
      snapshotCurrent = false;
    }
    if (!snapshotCurrent) await this.writeSnapshot(runId, authoritative);
    return authoritative;
  }

  public async commit(
    runId: string,
    expectedRevision: number,
    next: Ledger,
    eventInput: EventInput,
  ): Promise<Ledger> {
    const current = await this.load(runId);
    if (current.revision !== expectedRevision) {
      throw new StorageConflictError(
        `Run ${runId} expected revision ${expectedRevision}, found ${current.revision}.`,
      );
    }
    const revision = current.revision + 1;
    const state = LedgerSchema.parse({ ...next, runId, revision, updatedAt: new Date().toISOString() });
    const entry = JournalEntrySchema.parse({
      revision,
      previousRevision: current.revision,
      stateHash: stateHash(state),
      event: makeEvent(runId, eventInput),
      state,
    });
    await this.appendEntry(runId, entry);
    await this.writeSnapshot(runId, state);
    return state;
  }

  public async events(runId: string): Promise<DomainEvent[]> {
    return (await this.readJournal(runId)).map((entry) => entry.event);
  }

  public async latestRunId(): Promise<string> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.stateDirectory, "latest.json"), "utf8")) as {
        runId?: unknown;
      };
      if (typeof parsed.runId !== "string" || parsed.runId.length === 0) throw new Error("Missing runId.");
      return parsed.runId;
    } catch (error) {
      throw new Error(`No latest run is available: ${String(error)}.`, { cause: error });
    }
  }

  public async listRuns(): Promise<string[]> {
    try {
      const entries = await readdir(path.join(this.stateDirectory, "runs"), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("RUN-")).map((entry) => entry.name).sort().reverse();
    } catch {
      return [];
    }
  }

  public async acquireRunLock(runId: string): Promise<() => Promise<void>> {
    const lockPath = path.join(this.runDirectory(runId), ".writer.lock");
    const ownerToken = randomUUID();
    const metadata = { pid: process.pid, runId, createdAt: new Date().toISOString(), ownerToken, hostname: os.hostname() };
    let handle;
    for (;;) {
      try {
        handle = await open(lockPath, "wx");
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new StorageConflictError(`Unable to acquire writer lock for ${runId}: ${String(error)}.`);
        const rawLock = await readFile(lockPath, "utf8");
        let existing: { pid?: unknown; runId?: unknown; ownerToken?: unknown; hostname?: unknown; createdAt?: unknown };
        try {
          existing = /^\s*\d+\s*$/u.test(rawLock) ? { pid: Number(rawLock.trim()), runId, hostname: os.hostname(), createdAt: "legacy" } : JSON.parse(rawLock) as typeof existing;
        } catch (readError) { throw new StorageConflictError(`Run ${runId} has an unreadable writer lock; refusing takeover: ${String(readError)}.`); }
        const legacy = existing.ownerToken === undefined && existing.createdAt === "legacy";
        if (existing.runId !== runId || typeof existing.pid !== "number" || !Number.isInteger(existing.pid) || (!legacy && (typeof existing.ownerToken !== "string" || typeof existing.hostname !== "string"))) throw new StorageConflictError(`Run ${runId} has invalid writer-lock metadata; refusing takeover.`);
        let alive = true;
        try { process.kill(existing.pid, 0); } catch (probeError) { const code = (probeError as NodeJS.ErrnoException).code; if (code === "ESRCH") alive = false; else throw new StorageConflictError(`Run ${runId} writer lock owner could not be determined safely; refusing takeover: ${String(probeError)}.`); }
        if (alive) throw new StorageConflictError(`Run ${runId} already has an active writer lock (pid ${existing.pid}, host ${existing.hostname}, created ${String(existing.createdAt ?? "unknown")}).`);
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try { await rename(lockPath, stalePath); } catch (renameError) { if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue; throw new StorageConflictError(`Run ${runId} stale writer lock could not be safely claimed: ${String(renameError)}.`); }
        await unlink(stalePath).catch(() => undefined);
      }
    }
    const acquiredHandle = handle;
    return async () => {
      await acquiredHandle.close();
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8")) as { ownerToken?: unknown };
        if (current.ownerToken === ownerToken) await unlink(lockPath);
      } catch { /* lock was already recovered or removed */ }
    };
  }
}
