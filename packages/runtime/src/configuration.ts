import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  AgentDefinitionSchema,
  ObjectiveInputSchema,
  ProviderCapabilitySchema,
  RoleSchema,
  type AgentDefinition,
  type ObjectiveInput,
  type ProviderCapability,
  type Role,
} from "@agent-org/core";
import { parse } from "yaml";
import { z } from "zod";

const OrganizationSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  workflow: z.string().min(1),
  agentsDirectory: z.string().min(1),
  stateDirectory: z.string().min(1),
  providers: z.record(
    z.string().min(1),
    z.object({
      type: z.enum(["mock", "openai", "anthropic"]),
      defaultModel: z.string().min(1),
      timeoutMs: z.number().int().positive().default(120_000),
      maxRetries: z.number().int().nonnegative().default(2),
      retryBackoffMs: z.number().int().nonnegative().default(500),
      inputCostPerMillion: z.number().nonnegative().optional(),
      outputCostPerMillion: z.number().nonnegative().optional(),
    }),
  ),
  maxRework: z.number().int().nonnegative().default(2),
});

const WorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  requiredCapabilities: z.array(ProviderCapabilitySchema),
  stages: z.array(
    z.object({
      id: z.string().min(1),
      role: RoleSchema.exclude(["ENGINEERING_MANAGER"]),
    }),
  ),
});

export interface LoadedConfiguration {
  organization: z.infer<typeof OrganizationSchema>;
  workflow: z.infer<typeof WorkflowSchema>;
  agents: Map<Role, AgentDefinition>;
  stateDirectory: string;
}

async function readYaml(filePath: string): Promise<unknown> {
  return parse(await readFile(filePath, "utf8")) as unknown;
}

export async function loadConfiguration(repositoryRoot: string): Promise<LoadedConfiguration> {
  return await loadConfigurationFiles(repositoryRoot, path.join(repositoryRoot, ".agent-org", "organization.yaml"));
}

async function loadConfigurationFiles(configurationRoot: string, organizationFile: string): Promise<LoadedConfiguration> {
  const organization = OrganizationSchema.parse(
    await readYaml(organizationFile),
  );
  const agentsDirectory = path.resolve(configurationRoot, organization.agentsDirectory);
  const files = (await readdir(agentsDirectory)).filter((file) => file.endsWith(".yaml")).sort();
  const definitions = await Promise.all(
    files.map(async (file) => AgentDefinitionSchema.parse(await readYaml(path.join(agentsDirectory, file)))),
  );
  const ids = new Set(definitions.map((definition) => definition.id));
  const roles = new Set(definitions.map((definition) => definition.role));
  if (ids.size !== definitions.length || roles.size !== definitions.length) {
    throw new Error("Agent IDs and roles must be unique.");
  }
  const requiredRoles: Role[] = ["CHIEF_ENGINEER", "DEVELOPER", "TESTER", "REVIEWER"];
  for (const role of requiredRoles) {
    if (!roles.has(role as Exclude<Role, "ENGINEERING_MANAGER">)) {
      throw new Error(`Missing required agent role ${role}.`);
    }
  }
  for (const definition of definitions) {
    const preference = definition.providerPreference ?? "mock";
    if (!organization.providers[preference]) {
      throw new Error(`Agent ${definition.id} references unknown provider ${preference}.`);
    }
  }
  const workflow = WorkflowSchema.parse(await readYaml(path.resolve(configurationRoot, organization.workflow)));
  for (const stage of workflow.stages) {
    if (!roles.has(stage.role)) throw new Error(`Workflow stage ${stage.id} references missing role ${stage.role}.`);
  }
  return {
    organization,
    workflow,
    agents: new Map(definitions.map((definition) => [definition.role, definition])),
    stateDirectory: path.resolve(configurationRoot, organization.stateDirectory),
  };
}

const DEFAULT_ACTIONS = {
  CHIEF_ENGINEER: ["CREATE_TASK", "ASSIGN_TASK", "REOPEN_TASK", "BLOCK_TASK", "START_VERIFICATION", "START_REVIEW", "ACCEPT_TASK", "REJECT_TASK", "CANCEL_TASK", "ESCALATE", "COMPLETE_OBJECTIVE"],
  DEVELOPER: ["CLAIM_TASK", "SUBMIT_RESULT", "REQUEST_HELP", "REQUEST_REVIEW"],
  TESTER: ["CLAIM_TASK", "SUBMIT_VERIFICATION", "PASS_VERIFICATION", "FAIL_VERIFICATION"],
  REVIEWER: ["CLAIM_TASK", "APPROVE", "REQUEST_CHANGES", "BLOCK", "FLAG_RISK"],
} as const;

const READ_TOOLS = ["filesystem.read", "filesystem.list", "repository.search", "git.status", "git.diff"];

export function builtInConfiguration(stateDirectory: string): LoadedConfiguration {
  const organization = OrganizationSchema.parse({
    version: 1,
    name: "Portable Engineering Organization",
    workflow: "built-in",
    agentsDirectory: "built-in",
    stateDirectory,
    providers: {
      mock: { type: "mock", defaultModel: "deterministic", timeoutMs: 120_000, maxRetries: 0, retryBackoffMs: 0 },
      openai: { type: "openai", defaultModel: "gpt-5.4-mini", timeoutMs: 120_000, maxRetries: 2, retryBackoffMs: 500 },
      anthropic: { type: "anthropic", defaultModel: "claude-sonnet-4-20250514", timeoutMs: 120_000, maxRetries: 2, retryBackoffMs: 500 },
    },
    maxRework: 2,
  });
  const definitions = [
    { id: "chief-engineer", name: "Chief Engineer", role: "CHIEF_ENGINEER", mission: "Coordinate objectives and accept only independently verified work.", responsibilities: ["inspect bounded project context", "plan validated work", "enforce evidence gates"], required_outputs: ["final_report"], permissions: { actions: [...DEFAULT_ACTIONS.CHIEF_ENGINEER], tools: [...READ_TOOLS] } },
    { id: "developer", name: "Software Engineer", role: "DEVELOPER", mission: "Implement assigned scope and report reproducible evidence.", responsibilities: ["inspect and modify the isolated workspace", "update tests"], required_outputs: ["implementation_result"], permissions: { actions: [...DEFAULT_ACTIONS.DEVELOPER], tools: [...READ_TOOLS, "filesystem.write", "shell.execute"] } },
    { id: "tester", name: "Test Engineer", role: "TESTER", mission: "Independently verify acceptance criteria with configured commands.", responsibilities: ["run approved verification", "report exact evidence"], required_outputs: ["verification_result"], permissions: { actions: [...DEFAULT_ACTIONS.TESTER], tools: [...READ_TOOLS, "shell.execute"] } },
    { id: "reviewer", name: "Code Reviewer", role: "REVIEWER", mission: "Independently review implementation and evidence.", responsibilities: ["inspect the diff", "check acceptance criteria"], required_outputs: ["review_result"], permissions: { actions: [...DEFAULT_ACTIONS.REVIEWER], tools: [...READ_TOOLS] } },
  ].map((definition) => AgentDefinitionSchema.parse({ ...definition, may: [], may_not: [], providerPreference: "mock" }));
  const workflow = WorkflowSchema.parse({ id: "feature-v1.1", name: "Implement, verify, review, accept", requiredCapabilities: ["structuredOutput", "toolCalling"], stages: [
    { id: "implementation", role: "DEVELOPER" },
    { id: "verification", role: "TESTER" },
    { id: "review", role: "REVIEWER" },
    { id: "acceptance", role: "CHIEF_ENGINEER" },
  ] });
  return { organization, workflow, agents: new Map(definitions.map((definition) => [definition.role, definition])), stateDirectory };
}

export async function loadGlobalConfiguration(agentOrgHome: string, stateDirectory: string): Promise<LoadedConfiguration> {
  const organizationFile = path.join(agentOrgHome, "organization.yaml");
  if (!existsSync(organizationFile)) return builtInConfiguration(stateDirectory);
  const loaded = await loadConfigurationFiles(agentOrgHome, organizationFile);
  return { ...loaded, stateDirectory };
}

export async function loadObjective(objectivePath: string): Promise<ObjectiveInput> {
  return ObjectiveInputSchema.parse(await readYaml(objectivePath));
}

export function requiredCapabilities(configuration: LoadedConfiguration): ProviderCapability[] {
  return [...configuration.workflow.requiredCapabilities];
}
