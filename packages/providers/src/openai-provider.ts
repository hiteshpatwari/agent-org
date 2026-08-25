import { randomUUID } from "node:crypto";

import type {
  AgentExecutionRequest,
  AgentProvider,
  ActorPrincipal,
  ProviderCapabilities,
  ProviderSession,
  ProviderTurnResult,
  Role,
  Usage,
} from "@agent-org/core";
import OpenAI from "openai";

interface ResponsesClient {
  create(parameters: Record<string, unknown>): Promise<unknown>;
}

interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
  client?: ResponsesClient;
}

interface SessionState {
  model: string;
  previousResponseId?: string;
}

interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("OpenAI returned a non-object response.");
  return value as Record<string, unknown>;
}

function parseUsage(raw: unknown): Usage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as OpenAIUsage;
  return {
    ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
  };
}

function extractText(response: Record<string, unknown>): string {
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) throw new Error("OpenAI response did not contain output text.");
  const parts: string[] = [];
  for (const item of response.output) {
    if (typeof item !== "object" || item === null || !("content" in item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (typeof content === "object" && content !== null && "text" in content && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  if (parts.length === 0) throw new Error("OpenAI response did not contain output text.");
  return parts.join("");
}

export class OpenAIProvider implements AgentProvider {
  public readonly id = "openai";
  private readonly client: ResponsesClient;
  private readonly defaultModel: string;
  private readonly sessions = new Map<string, SessionState>();

  public constructor(options: OpenAIProviderOptions = {}) {
    const sdk = options.client ?? new OpenAI({ ...(options.apiKey ? { apiKey: options.apiKey } : {}) }).responses;
    this.client = sdk as unknown as ResponsesClient;
    this.defaultModel = options.model ?? process.env.AGENT_ORG_OPENAI_MODEL ?? "gpt-5.4-mini";
  }

  public capabilities(): ProviderCapabilities {
    return {
      textGeneration: true,
      structuredOutput: true,
      toolCalling: true,
      subagents: false,
      mcp: false,
      shell: false,
      filesystem: false,
      codeExecution: false,
      streaming: true,
      reasoning: true,
      imageInput: true,
    };
  }

  public async createSession(context: {
    principal: ActorPrincipal;
    role: Role;
    modelPreference?: string;
  }): Promise<ProviderSession> {
    const id = `openai-session-${randomUUID()}`;
    this.sessions.set(id, { model: context.modelPreference ?? this.defaultModel });
    return Promise.resolve({ id, providerId: this.id });
  }

  public async execute(
    session: ProviderSession,
    request: AgentExecutionRequest,
  ): Promise<ProviderTurnResult> {
    const state = this.sessions.get(session.id);
    if (!state) throw new Error(`Unknown OpenAI session ${session.id}.`);

    const input = request.toolResults
      ? request.toolResults.map((result) => ({
          type: "function_call_output",
          call_id: result.callId,
          output: JSON.stringify({ status: result.status, receiptId: result.receiptId, output: result.output }),
        }))
      : request.input;

    const raw = await this.client.create({
      model: state.model,
      instructions: [
        request.mission,
        "Return only the requested structured output. Never claim an identity or evidence not present in context.",
        `Trusted execution context: ${JSON.stringify(request.context)}`,
      ].join("\n\n"),
      input,
      ...(state.previousResponseId ? { previous_response_id: state.previousResponseId } : {}),
      tools: request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: true,
      })),
      text: {
        format: {
          type: "json_schema",
          name: request.expectedOutput.name,
          schema: request.expectedOutput.jsonSchema,
          strict: true,
        },
      },
    });

    const response = asRecord(raw);
    if (typeof response.id === "string") state.previousResponseId = response.id;
    const usage = parseUsage(response.usage);
    const model = typeof response.model === "string" ? response.model : state.model;
    const calls = Array.isArray(response.output)
      ? response.output.flatMap((item) => {
          if (
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "function_call" &&
            "call_id" in item &&
            typeof item.call_id === "string" &&
            "name" in item &&
            typeof item.name === "string" &&
            "arguments" in item &&
            typeof item.arguments === "string"
          ) {
            return [{ id: item.call_id, name: item.name, input: asRecord(JSON.parse(item.arguments)) }];
          }
          return [];
        })
      : [];
    if (calls.length > 0) return { type: "tool_calls", calls, ...(usage ? { usage } : {}), model };

    return {
      type: "completed",
      output: JSON.parse(extractText(response)),
      ...(usage ? { usage } : {}),
      model,
    };
  }

  public async closeSession(session: ProviderSession): Promise<void> {
    this.sessions.delete(session.id);
    await Promise.resolve();
  }
}
