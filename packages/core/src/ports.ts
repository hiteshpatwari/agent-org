import { z } from "zod";

import {
  ActorPrincipalSchema,
  ExecutionReceiptSchema,
  type ActorPrincipal,
  type ExecutionReceipt,
  type Role,
  type Usage,
  type WorkspaceState,
  type AgentDefinition,
} from "./schemas.js";

export const ProviderCapabilitySchema = z.enum([
  "textGeneration",
  "structuredOutput",
  "toolCalling",
  "subagents",
  "mcp",
  "shell",
  "filesystem",
  "codeExecution",
  "streaming",
  "reasoning",
  "imageInput",
]);
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export type ProviderCapabilities = Record<ProviderCapability, boolean>;

export const ToolSpecificationSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolSpecification = z.infer<typeof ToolSpecificationSchema>;

export const NeutralToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});
export type NeutralToolCall = z.infer<typeof NeutralToolCallSchema>;

export const NeutralToolResultSchema = z.object({
  callId: z.string().min(1),
  receiptId: z.string().min(1),
  status: z.enum(["SUCCEEDED", "FAILED"]),
  output: z.unknown(),
});
export type NeutralToolResult = z.infer<typeof NeutralToolResultSchema>;

export const ProviderSessionSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
});
export type ProviderSession = z.infer<typeof ProviderSessionSchema>;

export const AgentExecutionRequestSchema = z.object({
  principal: ActorPrincipalSchema,
  role: z.custom<Role>(),
  mission: z.string().min(1),
  input: z.string().min(1),
  context: z.record(z.string(), z.unknown()),
  tools: z.array(ToolSpecificationSchema),
  requiredCapabilities: z.array(ProviderCapabilitySchema),
  expectedOutput: z.object({
    name: z.string().min(1),
    jsonSchema: z.record(z.string(), z.unknown()),
  }),
  toolResults: z.array(NeutralToolResultSchema).optional(),
  validationFeedback: z.string().min(1).optional(),
});
export type AgentExecutionRequest = z.infer<typeof AgentExecutionRequestSchema>;

export type ProviderTurnResult =
  | {
      type: "tool_calls";
      calls: NeutralToolCall[];
      usage?: Usage;
      model?: string;
    }
  | {
      type: "completed";
      output: unknown;
      usage?: Usage;
      model?: string;
    };

export interface AgentProvider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  createSession(context: {
    principal: ActorPrincipal;
    role: Role;
    modelPreference?: string;
  }): Promise<ProviderSession>;
  execute(
    session: ProviderSession,
    request: AgentExecutionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderTurnResult>;
  closeSession(session: ProviderSession): Promise<void>;
}

export interface ToolRegistryPort {
  specificationsFor(principal: ActorPrincipal, allowedTools: string[]): ToolSpecification[];
  execute(
    principal: ActorPrincipal,
    workspacePath: string,
    allowedTools: string[],
    call: NeutralToolCall,
  ): Promise<{ result: NeutralToolResult; receipt: ExecutionReceipt }>;
}

export interface WorkspaceManagerPort {
  stage(templatePath: string, workspacePath: string): Promise<void>;
  inspect(workspacePath: string): Promise<WorkspaceState>;
}

export interface ProviderResolverPort {
  resolve(agent: AgentDefinition): AgentProvider;
}

export const ToolExecutionEnvelopeSchema = z.object({
  principal: ActorPrincipalSchema,
  workspacePath: z.string().min(1),
  receipt: ExecutionReceiptSchema,
});
