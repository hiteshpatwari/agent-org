import type {
  ActorPrincipal,
  AgentDefinition,
  AgentProvider,
  ExecutionReceipt,
  NeutralToolResult,
  ProviderCapability,
  ToolRegistryPort,
  Usage,
} from "@agent-org/core";
import { assertProviderCapabilities } from "@agent-org/core";
import type { z } from "zod";

export class AgentExecutionLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AgentExecutionLimitError";
  }
}

export interface AgentExecutionOutput<T> {
  value: T;
  receipts: ExecutionReceipt[];
  usage: Usage;
  model?: string;
  durationMs: number;
}

export interface AgentExecutorOptions {
  maxTurns?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
}

function combineUsage(total: Usage, next: Usage | undefined): Usage {
  if (!next) return total;
  const sum = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    ...(sum(total.inputTokens, next.inputTokens) !== undefined
      ? { inputTokens: sum(total.inputTokens, next.inputTokens) }
      : {}),
    ...(sum(total.outputTokens, next.outputTokens) !== undefined
      ? { outputTokens: sum(total.outputTokens, next.outputTokens) }
      : {}),
    ...(sum(total.totalTokens, next.totalTokens) !== undefined
      ? { totalTokens: sum(total.totalTokens, next.totalTokens) }
      : {}),
    ...(sum(total.costUsd, next.costUsd) !== undefined ? { costUsd: sum(total.costUsd, next.costUsd) } : {}),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentExecutionLimitError("Provider execution timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class AgentExecutor {
  private readonly maxTurns: number;
  private readonly maxToolCalls: number;
  private readonly timeoutMs: number;

  public constructor(
    private readonly provider: AgentProvider,
    private readonly tools: ToolRegistryPort,
    options: AgentExecutorOptions = {},
  ) {
    this.maxTurns = options.maxTurns ?? 6;
    this.maxToolCalls = options.maxToolCalls ?? 16;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  public async execute<T>(input: {
    principal: ActorPrincipal;
    agent: AgentDefinition;
    workspacePath: string;
    prompt: string;
    context: Record<string, unknown>;
    requiredCapabilities: ProviderCapability[];
    outputSchema: z.ZodType<T>;
    outputName: string;
    outputJsonSchema: Record<string, unknown>;
    onReceipt: (receipt: ExecutionReceipt) => Promise<void>;
  }): Promise<AgentExecutionOutput<T>> {
    assertProviderCapabilities(this.provider, input.requiredCapabilities);
    const session = await this.provider.createSession({
      principal: input.principal,
      role: input.agent.role,
      ...(input.agent.modelPreference ? { modelPreference: input.agent.modelPreference } : {}),
    });
    const started = Date.now();
    const receipts: ExecutionReceipt[] = [];
    let usage: Usage = {};
    let model: string | undefined;
    let toolResults: NeutralToolResult[] | undefined;
    let toolCallCount = 0;
    try {
      for (let turn = 1; turn <= this.maxTurns; turn += 1) {
        const remaining = this.timeoutMs - (Date.now() - started);
        if (remaining <= 0) throw new AgentExecutionLimitError("Agent execution exceeded its duration limit.");
        const result = await withTimeout(
          this.provider.execute(session, {
            principal: input.principal,
            role: input.agent.role,
            mission: input.agent.mission,
            input: input.prompt,
            context: input.context,
            tools: this.tools.specificationsFor(input.principal, input.agent.permissions.tools),
            requiredCapabilities: input.requiredCapabilities,
            expectedOutput: { name: input.outputName, jsonSchema: input.outputJsonSchema },
            ...(toolResults ? { toolResults } : {}),
          }),
          remaining,
        );
        usage = combineUsage(usage, result.usage);
        if (result.model) model = result.model;
        if (result.type === "completed") {
          return {
            value: input.outputSchema.parse(result.output),
            receipts,
            usage,
            ...(model ? { model } : {}),
            durationMs: Date.now() - started,
          };
        }
        if (result.calls.length === 0) throw new Error("Provider returned an empty tool-call turn.");
        toolCallCount += result.calls.length;
        if (toolCallCount > this.maxToolCalls) {
          throw new AgentExecutionLimitError(`Agent exceeded ${this.maxToolCalls} tool calls.`);
        }
        toolResults = [];
        for (const call of result.calls) {
          const executed = await this.tools.execute(
            input.principal,
            input.workspacePath,
            input.agent.permissions.tools,
            call,
          );
          receipts.push(executed.receipt);
          await input.onReceipt(executed.receipt);
          toolResults.push(executed.result);
        }
      }
      throw new AgentExecutionLimitError(`Agent exceeded ${this.maxTurns} provider turns.`);
    } finally {
      await this.provider.closeSession(session);
    }
  }
}
