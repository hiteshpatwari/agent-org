import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type {
  ActorPrincipal,
  ExecutionReceipt,
  NeutralToolCall,
  NeutralToolResult,
  ObjectiveInput,
  PreparedWorkspace,
  ToolRegistryPort,
  ToolSpecification,
  WorkspaceManagerPort,
  WorkspaceSource,
  WorkspaceState,
} from "@agent-org/core";
import { AuthorizationError, PreparedWorkspaceSchema, WorkspaceStateSchema, redactUnknown } from "@agent-org/core";
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
  assertNonSensitivePath(relativePath);
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

function assertNonSensitivePath(relativePath: string): void {
  const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const denied = segments.find((segment) => {
    const lower = segment.toLowerCase();
    return lower === ".git" || lower.startsWith(".env") || [".npmrc", ".pypirc", "id_rsa", "id_ed25519"].includes(lower) || lower.endsWith(".pem") || lower.endsWith(".key");
  });
  if (denied) throw new Error(`Sensitive path ${denied} is not accessible to agents.`);
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

const IGNORED_STATE_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

async function inspectWorkspace(workspacePath: string): Promise<WorkspaceState> {
  const root = await realpath(workspacePath);
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && IGNORED_STATE_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const content = await readFile(absolute);
        files.push({
          path: path.relative(root, absolute).replaceAll("\\", "/"),
          sha256: sha256(content),
          bytes: content.byteLength,
        });
      }
    }
  };
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return WorkspaceStateSchema.parse({ hash: sha256(JSON.stringify(files)), files });
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
          name: "repository.search",
          description: "Search UTF-8 repository files for a literal string. Results are bounded and sensitive paths are excluded.",
          inputSchema: jsonSchema(
            {
              query: { type: "string", minLength: 1, maxLength: 200 },
              path: { type: "string", default: "." },
              maxResults: { type: "integer", minimum: 1, maximum: 100, default: 40 },
            },
            ["query"],
          ),
        },
        execute: async (workspace, input) => {
          const parsed = z.object({
            query: z.string().min(1).max(200),
            path: z.string().default("."),
            maxResults: z.number().int().min(1).max(100).default(40),
          }).strict().parse(input);
          const target = await securePath(workspace, parsed.path);
          const matches: Array<{ path: string; line: number; text: string }> = [];
          const root = await realpath(workspace);
          const visit = async (candidate: string): Promise<void> => {
            if (matches.length >= parsed.maxResults) return;
            const info = await stat(candidate);
            if (info.isDirectory()) {
              for (const entry of await readdir(candidate, { withFileTypes: true })) {
                if (entry.isDirectory() && IGNORED_STATE_DIRECTORIES.has(entry.name)) continue;
                if (entry.isSymbolicLink()) continue;
                await visit(path.join(candidate, entry.name));
                if (matches.length >= parsed.maxResults) break;
              }
              return;
            }
            if (!info.isFile() || info.size > 512 * 1024) return;
            const relative = path.relative(root, candidate).replaceAll("\\", "/");
            try {
              assertNonSensitivePath(relative);
              const content = await readFile(candidate, "utf8");
              for (const [index, line] of content.split(/\r?\n/u).entries()) {
                if (line.includes(parsed.query)) {
                  matches.push({ path: relative, line: index + 1, text: line.slice(0, 500) });
                  if (matches.length >= parsed.maxResults) break;
                }
              }
            } catch {
              // Binary, unreadable, or sensitive files are excluded from search.
            }
          };
          await visit(target);
          return { cwd: root, output: { matches, truncated: matches.length >= parsed.maxResults } };
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
      raw = { output: { error: redactUnknown(error instanceof Error ? error.message : String(error)) }, cwd: await realpath(workspacePath), exitCode: null };
    }
    const safeOutput = redactUnknown(raw.output);
    const persistedInput = call.name === "filesystem.write"
      ? {
          path: typeof call.input.path === "string" ? call.input.path : "[invalid]",
          bytes: typeof call.input.content === "string" ? Buffer.byteLength(call.input.content) : 0,
          sha256: typeof call.input.content === "string" ? sha256(call.input.content) : undefined,
        }
      : redactUnknown(call.input);
    const workspaceState = await inspectWorkspace(workspacePath);
    const outputText = JSON.stringify(safeOutput);
    const receipt: ExecutionReceipt = {
      id: `RCT-${randomUUID()}`,
      runId: principal.runId,
      taskId: principal.taskId ?? "UNSCOPED",
      agentId: principal.agentId,
      toolName: call.name,
      input: persistedInput,
      output: safeOutput,
      status,
      ...(raw.cwd ? { cwd: raw.cwd } : {}),
      ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
      startedAt,
      completedAt: new Date().toISOString(),
      outputTruncated: Buffer.byteLength(outputText) > MAX_OUTPUT_BYTES,
      contentHashes: raw.contentHashes ?? {},
      ...(principal.iteration === undefined ? {} : { iteration: principal.iteration }),
      workspaceStateHash: workspaceState.hash,
    };
    return {
      receipt,
      result: { callId: call.id, receiptId: receipt.id, status, output: safeOutput },
    };
  }
}

export class LocalWorkspaceManager implements WorkspaceManagerPort {
  public async stage(templatePath: string, workspacePath: string): Promise<void> {
    const source = await realpath(templatePath);
    if (existsSync(workspacePath)) throw new Error(`Workspace destination already exists: ${workspacePath}.`);
    await mkdir(path.dirname(workspacePath), { recursive: true });
    const temporary = `${workspacePath}.staging-${randomUUID()}`;
    await cp(source, temporary, { recursive: true, force: false, errorOnExist: true });
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
      const result = await runFixedCommand(git, args, temporary, 10_000);
      if (result.exitCode !== 0) {
        await rm(temporary, { recursive: true, force: true });
        throw new Error(`Failed to initialize the run-local Git workspace: ${JSON.stringify(result.output)}.`);
      }
    }
    await rename(temporary, workspacePath);
  }

  public async inspect(workspacePath: string): Promise<WorkspaceState> {
    return await inspectWorkspace(workspacePath);
  }
}

export class TemplateWorkspaceSource implements WorkspaceSource {
  public constructor(
    private readonly sourceRoot: string,
    private readonly manager: WorkspaceManagerPort = new LocalWorkspaceManager(),
  ) {}

  public async prepare(input: { runId: string; objective: ObjectiveInput; workspacePath: string }): Promise<PreparedWorkspace> {
    await this.manager.stage(path.resolve(this.sourceRoot, input.objective.workspaceTemplate), input.workspacePath);
    return PreparedWorkspaceSchema.parse({ sourceType: "template", path: input.workspacePath });
  }
}

export class LocalGitWorkspaceSource implements WorkspaceSource {
  public constructor(private readonly projectRoot: string) {}

  private async cleanProjectRoot(): Promise<string> {
    const projectRoot = await realpath(this.projectRoot);
    const git = resolveExecutable("git");
    const status = await runFixedCommand(git, ["status", "--porcelain", "--untracked-files=all"], projectRoot, 10_000);
    if (status.exitCode !== 0) throw new Error("Unable to inspect the target Git repository before workspace creation.");
    const statusOutput = typeof status.output === "object" && status.output !== null && "stdout" in status.output
      ? String(status.output.stdout)
      : "";
    if (statusOutput.trim().length > 0) {
      throw new Error("The target Git repository has uncommitted changes. Commit or stash them before running Agent Org; dirty changes are never included automatically.");
    }
    return projectRoot;
  }

  public async preflight(): Promise<void> {
    await this.cleanProjectRoot();
  }

  public async prepare(input: { runId: string; objective: ObjectiveInput; workspacePath: string }): Promise<PreparedWorkspace> {
    const projectRoot = await this.cleanProjectRoot();
    const git = resolveExecutable("git");
    if (existsSync(input.workspacePath)) throw new Error(`Workspace destination already exists: ${input.workspacePath}.`);
    await mkdir(path.dirname(input.workspacePath), { recursive: true });
    const branch = `agent-org/${input.runId.toLowerCase()}`;
    const result = await runFixedCommand(git, ["worktree", "add", "-b", branch, input.workspacePath, "HEAD"], projectRoot, 30_000);
    if (result.exitCode !== 0) throw new Error(`Failed to create the isolated Git worktree: ${JSON.stringify(result.output)}.`);
    return PreparedWorkspaceSchema.parse({ sourceType: "local-git", path: input.workspacePath, projectRoot, branch });
  }
}
