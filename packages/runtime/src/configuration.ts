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
      type: z.enum(["mock", "openai"]),
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
  const organization = OrganizationSchema.parse(
    await readYaml(path.join(repositoryRoot, ".agent-org", "organization.yaml")),
  );
  const agentsDirectory = path.resolve(repositoryRoot, organization.agentsDirectory);
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
  const workflow = WorkflowSchema.parse(await readYaml(path.resolve(repositoryRoot, organization.workflow)));
  for (const stage of workflow.stages) {
    if (!roles.has(stage.role)) throw new Error(`Workflow stage ${stage.id} references missing role ${stage.role}.`);
  }
  return {
    organization,
    workflow,
    agents: new Map(definitions.map((definition) => [definition.role, definition])),
    stateDirectory: path.resolve(repositoryRoot, organization.stateDirectory),
  };
}

export async function loadObjective(objectivePath: string): Promise<ObjectiveInput> {
  return ObjectiveInputSchema.parse(await readYaml(objectivePath));
}

export function requiredCapabilities(configuration: LoadedConfiguration): ProviderCapability[] {
  return [...configuration.workflow.requiredCapabilities];
}
