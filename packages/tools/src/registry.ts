import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type {
  ActorPrincipal,
  ExecutionReceipt,
  NeutralToolCall,
  NeutralToolResult,
  ToolRegistryPort,
  ToolSpecification,
  WorkspaceManagerPort,
} from "@agent-org/core";
import { AuthorizationError } from "@agent-org/core";
import { z } from "zod";

export interface CommandTemplate {
  id: string;
  description: string;
  executable: string;
  args: string[];
  timeoutMs: number;
}

interface RawToolResult {
  output: unknown;
  cwd?: string;
  exitCode?: number | null;
  contentHashes?: Record<string, string>;
}

interface ToolImplementation {
  specification: ToolSpecification;
  execute(workspacePath: string, input: Record<string, unknown>): Promise<RawToolResult>;
}

const MAX_OUTPUT_BYTES = 64 * 1024;

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalized(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(normalized(root), normalized(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function securePath(workspacePath: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath)) throw new Error("Absolute paths are not allowed.");
  const root = await realpath(workspacePath);
  const candidate = path.resolve(root, relativePath);
  if (!isInside(root, candidate)) throw new Error("Path escapes the assigned workspace.");

  let existing = candidate;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("Unable to resolve a safe existing parent.");
    existing = parent;
  }
  const realExisting = await realpath(existing);
  if (!isInside(root, realExisting)) throw new Error("Path resolves outside the assigned workspace.");
  if (existsSync(candidate)) {
    const realCandidate = await realpath(candidate);
    if (!isInside(root, realCandidate)) throw new Error("Path resolves outside the assigned workspace.");
  }
  return candidate;
}

function redactedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/(OPENAI_API_KEY\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
}

function bounded(value: string): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= MAX_OUTPUT_BYTES) return { text: value, truncated: false };
  return { text: buffer.subarray(0, MAX_OUTPUT_BYTES).toString("utf8"), truncated: true };
}

function resolveExecutable(name: string): string {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const output = execFileSync(locator, [name], { encoding: "utf8", windowsHide: true });
  const first = output.split(/\r?\n/u).find((line) => line.trim().length > 0);
  if (!first) throw new Error(`Could not resolve executable ${name}.`);
  return path.resolve(first.trim());
}

async function runFixedCommand(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RawToolResult> {
  const realCwd = await realpath(cwd);
  const safeEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    NODE_NO_WARNINGS: "1",
  };
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: realCwd,
      env: safeEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) <= MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) <= MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms.`));
        return;
      }
      const out = bounded(stdout);
      const err = bounded(stderr);
      resolve({
        cwd: realCwd,
        exitCode: code,
        output: {
          executable,
          argv: [...args],
          stdout: out.text,
          stderr: err.text,
          exitCode: code,
          outputTruncated: out.truncated || err.truncated,
        },
      });
    });
  });
}

function jsonSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

export class LocalToolRegistry implements ToolRegistryPort {
  private readonly tools: Map<string, ToolImplementation>;

  public constructor(commandTemplates: CommandTemplate[] = []) {
    const commands = new Map(commandTemplates.map((command) => [command.id, command]));
    const git = resolveExecutable("git");
    const implementations: ToolImplementation[] = [
      {
        specification: {
          name: "filesystem.read",
          description: "Read one UTF-8 file inside the assigned workspace.",
          inputSchema: jsonSchema({ path: { type: "string", minLength: 1 } }, ["path"]),
        },
        execute: async (workspace, input) => {
          const parsed = z.object({ path: z.string().min(1) }).strict().parse(input);
          const target = await securePath(workspace, parsed.path);
          const content = await readFile(target, "utf8");
          const output = bounded(content);
          return {
            cwd: await realpath(workspace),
            output: { path: parsed.path, content: output.text, outputTruncated: output.truncated },
            contentHashes: { [parsed.path]: sha256(content) },
          };
        },
      },
      {
        specification: {
          name: "filesystem.write",
          description: "Write one UTF-8 file inside the assigned workspace.",
          inputSchema: jsonSchema(
            { path: { type: "string", minLength: 1 }, content: { type: "string" } },
            ["path", "content"],
          ),
        },
        execute: async (workspace, input) => {
          const parsed = z.object({ path: z.string().min(1), content: z.string() }).strict().parse(input);
          const target = await securePath(workspace, parsed.path);
          if (existsSync(target) && (await lstat(target)).isSymbolicLink()) {
            throw new Error("Writing through a symbolic link is not allowed.");
          }
          await mkdir(path.dirname(target), { recursive: true });
          const safeParent = await realpath(path.dirname(target));
          const safeRoot = await realpath(workspace);
          if (!isInside(safeRoot, safeParent)) throw new Error("Write parent resolves outside the workspace.");
          await writeFile(target, parsed.content, "utf8");
          return {
            cwd: safeRoot,
            output: { path: parsed.path, bytesWritten: Buffer.byteLength(parsed.content) },
            contentHashes: { [parsed.path]: sha256(parsed.content) },
          };
        },
      },
      {
        specification: {
          name: "filesystem.list",
          description: "List direct children of a directory inside the assigned workspace.",
          inputSchema: jsonSchema({ path: { type: "string", default: "." } }, []),
        },
        execute: async (workspace, input) => {
          const parsed = z.object({ path: z.string().default(".") }).strict().parse(input);
          const target = await securePath(workspace, parsed.path);
          const entries = await readdir(target, { withFileTypes: true });
          return {
            cwd: await realpath(workspace),
            output: entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" })),
          };
        },
      },
      {
        specification: {
          name: "shell.execute",
          description: "Execute one pre-approved fixed command template in the assigned workspace.",
          inputSchema: jsonSchema(
            { commandId: { type: "string", enum: [...commands.keys()] } },
            ["commandId"],
          ),
        },
        execute: async (workspace, input) => {
          const parsed = z.object({ commandId: z.string().min(1) }).strict().parse(input);
          const command = commands.get(parsed.commandId);
          if (!command) throw new Error(`Unknown command template ${parsed.commandId}.`);
          return await runFixedCommand(command.executable, command.args, workspace, command.timeoutMs);
        },
      },
      {
        specification: {
          name: "git.status",
          description: "Read short Git status for the assigned workspace.",
          inputSchema: jsonSchema({}, []),
        },
        execute: async (workspace, input) => {
          z.object({}).strict().parse(input);
          return await runFixedCommand(git, ["status", "--short"], workspace, 10_000);
        },
      },
      {
        specification: {
          name: "git.diff",
          description: "Read the no-ext-diff Git patch for the assigned workspace.",
          inputSchema: jsonSchema({}, []),
        },
        execute: async (workspace, input) => {
          z.object({}).strict().parse(input);
          return await runFixedCommand(
            git,
            ["diff", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"],
            workspace,
            10_000,
          );
        },
      },
    ];
    this.tools = new Map(implementations.map((tool) => [tool.specification.name, tool]));
  }

  public specificationsFor(principal: ActorPrincipal, allowedTools: string[]): ToolSpecification[] {
    void principal;
    return allowedTools.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Configured tool ${name} is not registered.`);
      return tool.specification;
    });
  }

  public async execute(
    principal: ActorPrincipal,
    workspacePath: string,
    allowedTools: string[],
    call: NeutralToolCall,
  ): Promise<{ result: NeutralToolResult; receipt: ExecutionReceipt }> {
    if (!allowedTools.includes(call.name)) {
      throw new AuthorizationError(`${principal.agentId} is not permitted to use ${call.name}.`);
    }
    const tool = this.tools.get(call.name);
    if (!tool) throw new Error(`Unknown tool ${call.name}.`);
    const startedAt = new Date().toISOString();
    let raw: RawToolResult;
    let status: ExecutionReceipt["status"] = "SUCCEEDED";
    try {
      raw = await tool.execute(workspacePath, call.input);
      if (raw.exitCode !== undefined && raw.exitCode !== null && raw.exitCode !== 0) status = "FAILED";
    } catch (error) {
      status = "FAILED";
      raw = { output: { error: redactedError(error) }, cwd: await realpath(workspacePath), exitCode: null };
    }
    const outputText = JSON.stringify(raw.output);
    const receipt: ExecutionReceipt = {
      id: `RCT-${randomUUID()}`,
      runId: principal.runId,
      taskId: principal.taskId ?? "UNSCOPED",
      agentId: principal.agentId,
      toolName: call.name,
      input: { ...call.input },
      output: raw.output,
      status,
      ...(raw.cwd ? { cwd: raw.cwd } : {}),
      ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
      startedAt,
      completedAt: new Date().toISOString(),
      outputTruncated: Buffer.byteLength(outputText) > MAX_OUTPUT_BYTES,
      contentHashes: raw.contentHashes ?? {},
    };
    return {
      receipt,
      result: { callId: call.id, receiptId: receipt.id, status, output: raw.output },
    };
  }
}

export class LocalWorkspaceManager implements WorkspaceManagerPort {
  public async stage(templatePath: string, workspacePath: string): Promise<void> {
    const source = await realpath(templatePath);
    if (existsSync(workspacePath)) throw new Error(`Workspace destination already exists: ${workspacePath}.`);
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await cp(source, workspacePath, { recursive: true, force: false, errorOnExist: true });
    const git = resolveExecutable("git");
    const commands: string[][] = [
      ["init", "-b", "main"],
      ["add", "--all"],
      [
        "-c",
        "user.name=Agent Org",
        "-c",
        "user.email=agent-org@example.invalid",
        "commit",
        "-m",
        "Baseline sample workspace",
      ],
    ];
    for (const args of commands) {
      const result = await runFixedCommand(git, args, workspacePath, 10_000);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to initialize the run-local Git workspace: ${JSON.stringify(result.output)}.`);
      }
    }
  }
}
