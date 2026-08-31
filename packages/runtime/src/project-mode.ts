import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ObjectiveInputSchema, RiskSchema, type ObjectiveInput, type Risk } from "@agent-org/core";
import { parse } from "yaml";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const SAFE_SCRIPTS = ["test", "lint", "typecheck", "build"] as const;

const ProjectConfigurationSchema = z.object({
  verification: z.object({
    test: z.string().min(1).optional(),
    lint: z.string().min(1).optional(),
    typecheck: z.string().min(1).optional(),
    build: z.string().min(1).optional(),
  }).strict().default({}),
  context: z.object({ include: z.array(z.string().min(1)).default([]) }).strict().default({ include: [] }),
  risk: z.object({ default: RiskSchema.default("MEDIUM") }).strict().default({ default: "MEDIUM" }),
}).strict();

const ProjectConfigurationInputSchema = z.object({
  verification: z.object({ test: z.string().min(1).optional(), lint: z.string().min(1).optional(), typecheck: z.string().min(1).optional(), build: z.string().min(1).optional() }).strict().optional(),
  context: z.object({ include: z.array(z.string().min(1)).optional() }).strict().optional(),
  risk: z.object({ default: RiskSchema.optional() }).strict().optional(),
}).strict();

export type ProjectConfiguration = z.infer<typeof ProjectConfigurationSchema>;

export interface ProjectModePaths {
  agentOrgHome: string;
  projectRoot: string;
  runtimeStateRoot: string;
  projectId: string;
}

export interface DiscoveredProjectCommand {
  id: `project.${typeof SAFE_SCRIPTS[number]}`;
  description: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  script: string;
  packageManager: "pnpm" | "yarn" | "npm";
}

export function agentOrgHome(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.AGENT_ORG_HOME?.trim();
  return path.resolve(override && override.length > 0 ? override : path.join(os.homedir(), ".agent-org"));
}

export async function discoverGitRoot(cwd: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, windowsHide: true, timeout: 10_000 });
    return await realpath(result.stdout.trim());
  } catch {
    throw new Error(`Agent Org project mode requires an existing Git repository. No repository was found from ${path.resolve(cwd)}; Git was not initialized.`);
  }
}

export async function resolveProjectModePaths(cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<ProjectModePaths> {
  const projectRoot = await discoverGitRoot(cwd);
  const home = agentOrgHome(environment);
  const canonical = process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot;
  const projectId = createHash("sha256").update(canonical).digest("hex").slice(0, 20);
  return { agentOrgHome: home, projectRoot, projectId, runtimeStateRoot: path.join(home, "projects", projectId) };
}

async function readProjectConfiguration(file: string): Promise<z.infer<typeof ProjectConfigurationInputSchema>> {
  return existsSync(file) ? ProjectConfigurationInputSchema.parse(parse(await readFile(file, "utf8")) as unknown) : {};
}

export async function loadProjectConfiguration(projectRoot: string, globalHome?: string): Promise<ProjectConfiguration> {
  const global = globalHome ? await readProjectConfiguration(path.join(globalHome, "project-defaults.yaml")) : {};
  const project = await readProjectConfiguration(path.join(projectRoot, ".agent-org.yaml"));
  return ProjectConfigurationSchema.parse({
    verification: { ...global.verification, ...project.verification },
    context: { include: project.context?.include ?? global.context?.include ?? [] },
    risk: { default: project.risk?.default ?? global.risk?.default ?? "MEDIUM" },
  });
}

function isSensitiveContextFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/");
  return parts.some((part) => part === ".git" || part.startsWith(".env") || [".npmrc", ".yarnrc", "credentials", "id_rsa", "id_ed25519"].includes(part) || part.endsWith(".pem") || part.endsWith(".key"));
}

export function discoverProjectContextFiles(projectRoot: string, configured: string[] = []): string[] {
  const candidates = ["AGENTS.md", "README.md", "PRODUCT.md", "package.json", "tsconfig.json", ...configured];
  return [...new Set(candidates)]
    .filter((relative) => !path.isAbsolute(relative) && !relative.startsWith("..") && !isSensitiveContextFile(relative))
    .filter((relative) => existsSync(path.join(projectRoot, relative)));
}

function declaredPackageManager(value: unknown): "pnpm" | "yarn" | "npm" | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.split("@")[0];
  return name === "pnpm" || name === "yarn" || name === "npm" ? name : undefined;
}

export async function discoverProjectCommands(projectRoot: string, configuration: ProjectConfiguration): Promise<DiscoveredProjectCommand[]> {
  const packageFile = path.join(projectRoot, "package.json");
  if (!existsSync(packageFile)) return [];
  const packageJson = JSON.parse(await readFile(packageFile, "utf8")) as { packageManager?: unknown; scripts?: Record<string, unknown> };
  const packageManager = declaredPackageManager(packageJson.packageManager)
    ?? (existsSync(path.join(projectRoot, "pnpm-lock.yaml")) ? "pnpm" : undefined)
    ?? (existsSync(path.join(projectRoot, "yarn.lock")) ? "yarn" : undefined)
    ?? (existsSync(path.join(projectRoot, "package-lock.json")) ? "npm" : undefined)
    ?? "npm";
  const scripts = packageJson.scripts ?? {};
  return SAFE_SCRIPTS.flatMap((purpose) => {
    const script = configuration.verification[purpose] ?? purpose;
    if (!/^[a-zA-Z0-9:_-]+$/u.test(script)) throw new Error(`Configured project script name is not safe: ${script}.`);
    if (typeof scripts[script] !== "string") return [];
    const windows = process.platform === "win32";
    return [{
      id: `project.${purpose}` as const,
      description: `Run the project's configured ${purpose} script (${script}) with ${packageManager}.`,
      executable: windows ? (process.env.ComSpec ?? "cmd.exe") : packageManager,
      args: windows ? ["/d", "/s", "/c", `${packageManager} run ${script}`] : ["run", script],
      timeoutMs: purpose === "build" || purpose === "test" ? 120_000 : 60_000,
      script,
      packageManager,
    }];
  });
}

export class ObjectiveBuilder {
  public build(input: {
    prompt: string;
    projectRoot: string;
    contextFiles: string[];
    verificationCommandIds: string[];
    risk?: Risk;
  }): ObjectiveInput {
    const prompt = input.prompt.trim();
    if (prompt.length === 0) throw new Error("The project objective prompt cannot be empty.");
    const title = prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt;
    const verification = input.verificationCommandIds.length > 0
      ? ` Discovered verification commands (${input.verificationCommandIds.join(", ")}) must pass.`
      : " No supported project verification script was discovered; verification must rely on bounded repository evidence.";
    return ObjectiveInputSchema.parse({
      title,
      description: prompt,
      risk: input.risk ?? "MEDIUM",
      workspaceTemplate: input.projectRoot,
      requirements: [{ id: "REQ-1", text: prompt }],
      acceptanceCriteria: [{ id: "AC-1", text: `The requested change is implemented in the isolated workspace and independently reviewed.${verification}` }],
      contextFiles: input.contextFiles,
      verificationCommandIds: input.verificationCommandIds,
    });
  }
}
