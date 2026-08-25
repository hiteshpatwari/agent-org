import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { ArtifactSchema, type Artifact } from "@agent-org/core";

import type { BlackboardStore } from "./storage.js";

export class ArtifactIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ArtifactIntegrityError";
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class FileArtifactStore {
  public constructor(private readonly blackboard: BlackboardStore) {}

  public async create(input: {
    runId: string;
    taskId?: string;
    type: Artifact["type"];
    title: string;
    mediaType: string;
    content: string;
    createdBy: string;
  }): Promise<Artifact> {
    const sha256 = hash(input.content);
    const extension = input.mediaType === "application/json" ? "json" : "md";
    const relativePath = path.join("artifacts", `${sha256}.${extension}`).replaceAll("\\", "/");
    const absolutePath = path.join(this.blackboard.runDirectory(input.runId), relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    if (!existsSync(absolutePath)) await writeFile(absolutePath, input.content, "utf8");
    return ArtifactSchema.parse({
      id: `ART-${sha256.slice(0, 20)}`,
      runId: input.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      type: input.type,
      title: input.title,
      mediaType: input.mediaType,
      path: relativePath,
      sha256,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    });
  }

  public async verify(artifact: Artifact): Promise<void> {
    const absolutePath = path.join(this.blackboard.runDirectory(artifact.runId), artifact.path);
    const content = await readFile(absolutePath, "utf8");
    if (hash(content) !== artifact.sha256) {
      throw new ArtifactIntegrityError(`Artifact ${artifact.id} failed its SHA-256 integrity check.`);
    }
  }
}
