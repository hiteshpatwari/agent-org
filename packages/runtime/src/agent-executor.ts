import {
  ProviderExecutionError,
  assertProviderCapabilities,
  providerErrorRecord,
  type ActorPrincipal,
  type AgentDefinition,
  type AgentProvider,
  type ExecutionReceipt,
  type NeutralToolResult,
  type ProviderAttempt,
  type ProviderCapability,
  type ToolRegistryPort,
  type Usage,
} from "@agent-org/core";
import type { z } from "zod";

export class AgentExecutionLimitError extends Error {
  public constructor(message: string) { super(message); this.name = "AgentExecutionLimitError"; }
}

export interface AgentExecutionOutput<T> {
  value: T;
  receipts: ExecutionReceipt[];
  usage: Usage;
  model?: string;
  durationMs: number;
  attempts: ProviderAttempt[];
  retryCount: number;
}

export interface AgentExecutorOptions {
  maxTurns?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

function combineUsage(total: Usage, next: Usage | undefined): Usage {
  if (!next) return total;
  const sum = (a: number | undefined, b: number | undefined): number | undefined => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const inputTokens = sum(total.inputTokens, next.inputTokens);
  const outputTokens = sum(total.outputTokens, next.outputTokens);
  const totalTokens = sum(total.totalTokens, next.totalTokens);
  const costUsd = sum(total.costUsd, next.costUsd);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

export class AgentExecutor {
  private readonly maxTurns: number;
  private readonly maxToolCalls: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;

  public constructor(private readonly provider: AgentProvider, private readonly tools: ToolRegistryPort, options: AgentExecutorOptions = {}) {
    this.maxTurns = options.maxTurns ?? 8;
    this.maxToolCalls = options.maxToolCalls ?? 24;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBackoffMs = options.retryBackoffMs ?? 500;
    this.sleep = options.sleep ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
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
    signal?: AbortSignal;
    validateOutput?: (value: T, receipts: ExecutionReceipt[]) => string | undefined;
    onReceipt: (receipt: ExecutionReceipt) => Promise<void>;
    onAttempt?: (attempt: ProviderAttempt) => Promise<void>;
    onRetry?: (error: ReturnType<typeof providerErrorRecord>, retryNumber: number) => Promise<void>;
  }): Promise<AgentExecutionOutput<T>> {
    assertProviderCapabilities(this.provider, input.requiredCapabilities);
    const session = await this.provider.createSession({ principal: input.principal, role: input.agent.role, ...(input.agent.modelPreference ? { modelPreference: input.agent.modelPreference } : {}) });
    const started = Date.now();
    const receipts: ExecutionReceipt[] = [];
    const attempts: ProviderAttempt[] = [];
    let usage: Usage = {};
    let model: string | undefined;
    let toolResults: NeutralToolResult[] | undefined;
    let validationFeedback: string | undefined;
    let toolCallCount = 0;
    let retryCount = 0;
    try {
      for (let turn = 1; turn <= this.maxTurns; turn += 1) {
        let turnRetry = 0;
        while (true) {
          const remaining = this.timeoutMs - (Date.now() - started);
          if (remaining <= 0) throw new ProviderExecutionError({ code: "TIMEOUT", message: "Agent execution exceeded its duration limit.", retryable: false, providerId: this.provider.id });
          const number = attempts.length + 1;
          const attemptStarted = this.now();
          const running: ProviderAttempt = { number, turn, status: "RUNNING", startedAt: attemptStarted.toISOString() };
          attempts.push(running);
          await input.onAttempt?.(running);
          const controller = new AbortController();
          const abort = () => controller.abort();
          input.signal?.addEventListener("abort", abort, { once: true });
          const timer = setTimeout(() => controller.abort(), remaining);
          try {
            const result = await this.provider.execute(session, {
              principal: input.principal,
              role: input.agent.role,
              mission: input.agent.mission,
              input: input.prompt,
              context: input.context,
              tools: this.tools.specificationsFor(input.principal, input.agent.permissions.tools),
              requiredCapabilities: input.requiredCapabilities,
              expectedOutput: { name: input.outputName, jsonSchema: input.outputJsonSchema },
              ...(toolResults ? { toolResults } : {}),
              ...(validationFeedback ? { validationFeedback } : {}),
            }, { signal: controller.signal });
            clearTimeout(timer);
            input.signal?.removeEventListener("abort", abort);
            usage = combineUsage(usage, result.usage);
            if (result.model) model = result.model;
            if (result.type === "completed") {
              const parsed = input.outputSchema.safeParse(result.output);
              if (!parsed.success) {
                const error = new ProviderExecutionError({ code: "INVALID_RESPONSE", message: `Structured output validation failed: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`, retryable: true, providerId: this.provider.id });
                const failed: ProviderAttempt = { ...running, status: "FAILED", completedAt: this.now().toISOString(), durationMs: Math.max(0, this.now().getTime() - attemptStarted.getTime()), error: error.record };
                attempts[attempts.length - 1] = failed;
                await input.onAttempt?.(failed);
                if (turnRetry >= this.maxRetries) throw error;
                turnRetry += 1;
                retryCount += 1;
                validationFeedback = error.message;
                toolResults = undefined;
                await input.onRetry?.(error.record, retryCount);
                continue;
              }
              const semanticError = input.validateOutput?.(parsed.data, receipts);
              if (semanticError) {
                const error = new ProviderExecutionError({ code: "INVALID_RESPONSE", message: semanticError, retryable: true, providerId: this.provider.id });
                const failed: ProviderAttempt = { ...running, status: "FAILED", completedAt: this.now().toISOString(), durationMs: Math.max(0, this.now().getTime() - attemptStarted.getTime()), error: error.record };
                attempts[attempts.length - 1] = failed;
                await input.onAttempt?.(failed);
                if (turnRetry >= this.maxRetries) throw error;
                turnRetry += 1;
                retryCount += 1;
                validationFeedback = error.message;
                toolResults = undefined;
                await input.onRetry?.(error.record, retryCount);
                continue;
              }
              const succeeded: ProviderAttempt = { ...running, status: "SUCCEEDED", completedAt: this.now().toISOString(), durationMs: Math.max(0, this.now().getTime() - attemptStarted.getTime()) };
              attempts[attempts.length - 1] = succeeded;
              await input.onAttempt?.(succeeded);
              return { value: parsed.data, receipts, usage, ...(model ? { model } : {}), durationMs: Date.now() - started, attempts, retryCount };
            }
            const succeeded: ProviderAttempt = { ...running, status: "SUCCEEDED", completedAt: this.now().toISOString(), durationMs: Math.max(0, this.now().getTime() - attemptStarted.getTime()) };
            attempts[attempts.length - 1] = succeeded;
            await input.onAttempt?.(succeeded);
            if (result.calls.length === 0) throw new ProviderExecutionError({ code: "INVALID_RESPONSE", message: "Provider returned an empty tool-call turn.", retryable: false, providerId: this.provider.id });
            toolCallCount += result.calls.length;
            if (toolCallCount > this.maxToolCalls) throw new AgentExecutionLimitError(`Agent exceeded ${this.maxToolCalls} tool calls.`);
            toolResults = [];
            validationFeedback = undefined;
            for (const call of result.calls) {
              const executed = await this.tools.execute(input.principal, input.workspacePath, input.agent.permissions.tools, call);
              receipts.push(executed.receipt);
              await input.onReceipt(executed.receipt);
              toolResults.push(executed.result);
            }
            break;
          } catch (error) {
            clearTimeout(timer);
            input.signal?.removeEventListener("abort", abort);
            const normalized = controller.signal.aborted
              ? new ProviderExecutionError({ code: input.signal?.aborted ? "CANCELLED" : "TIMEOUT", message: input.signal?.aborted ? "Agent execution was cancelled." : "Provider execution timed out.", retryable: false, providerId: this.provider.id, cause: error })
              : providerErrorRecord(error, this.provider.id);
            const failed: ProviderAttempt = { ...running, status: "FAILED", completedAt: this.now().toISOString(), durationMs: Math.max(0, this.now().getTime() - attemptStarted.getTime()), error: normalized instanceof ProviderExecutionError ? normalized.record : normalized };
            attempts[attempts.length - 1] = failed;
            await input.onAttempt?.(failed);
            const record = normalized instanceof ProviderExecutionError ? normalized.record : normalized;
            if (!record.retryable || receipts.length > 0 || turnRetry >= this.maxRetries) {
              throw normalized instanceof ProviderExecutionError ? normalized : new ProviderExecutionError({
                code: record.code,
                message: record.message,
                retryable: record.retryable,
                providerId: record.providerId,
                ...(record.statusCode === undefined ? {} : { statusCode: record.statusCode }),
              });
            }
            turnRetry += 1;
            retryCount += 1;
            await input.onRetry?.(record, retryCount);
            await this.sleep(this.retryBackoffMs * 2 ** (turnRetry - 1));
          }
        }
      }
      throw new AgentExecutionLimitError(`Agent exceeded ${this.maxTurns} provider turns.`);
    } finally {
      await this.provider.closeSession(session).catch(() => undefined);
    }
  }
}
