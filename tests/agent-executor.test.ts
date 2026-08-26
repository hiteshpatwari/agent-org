import type {
  AgentProvider,
  ExecutionReceipt,
  NeutralToolCall,
  ProviderCapabilities,
  ToolRegistryPort,
} from "@agent-org/core";
import { ProviderExecutionError } from "@agent-org/core";
import { AgentExecutionLimitError, AgentExecutor } from "@agent-org/runtime";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { agent, principal, receipt } from "./helpers.js";

const allRequired: ProviderCapabilities = {
  textGeneration: true,
  structuredOutput: true,
  toolCalling: true,
  subagents: false,
  mcp: false,
  shell: false,
  filesystem: false,
  codeExecution: false,
  streaming: false,
  reasoning: false,
  imageInput: false,
};

describe("AgentExecutor limits", () => {
  it("halts a provider that never completes", async () => {
    let call = 0;
    const provider: AgentProvider = {
      id: "looping",
      capabilities: () => allRequired,
      createSession: async () => ({ id: "session", providerId: "looping" }),
      execute: async () => {
        call += 1;
        return {
          type: "tool_calls",
          calls: [{ id: `call-${call}`, name: "filesystem.read", input: { path: "x" } }],
        };
      },
      closeSession: async () => undefined,
    };
    const tools: ToolRegistryPort = {
      specificationsFor: () => [
        { name: "filesystem.read", description: "read", inputSchema: { type: "object" } },
      ],
      execute: async (_principal, _workspace, _allowed, toolCall: NeutralToolCall) => {
        const executed = receipt({ id: `RCT-${toolCall.id}`, agentId: "developer" });
        return {
          receipt: executed,
          result: {
            callId: toolCall.id,
            receiptId: executed.id,
            status: "SUCCEEDED",
            output: {},
          },
        };
      },
    };
    const executor = new AgentExecutor(provider, tools, { maxTurns: 2, maxToolCalls: 4, timeoutMs: 1000 });
    const saved: ExecutionReceipt[] = [];
    await expect(
      executor.execute({
        principal: principal("DEVELOPER", "developer"),
        agent: agent("DEVELOPER", "developer", [], ["filesystem.read"]),
        workspacePath: process.cwd(),
        prompt: "loop",
        context: {},
        requiredCapabilities: ["structuredOutput", "toolCalling"],
        outputSchema: z.object({ ok: z.boolean() }),
        outputName: "result",
        outputJsonSchema: { type: "object" },
        onReceipt: async (value) => {
          saved.push(value);
        },
      }),
    ).rejects.toBeInstanceOf(AgentExecutionLimitError);
    expect(saved).toHaveLength(2);
  });

  it("retries a normalized transient provider failure before local effects", async () => {
    let calls = 0;
    const provider: AgentProvider = {
      id: "transient",
      capabilities: () => allRequired,
      createSession: async () => ({ id: "session", providerId: "transient" }),
      execute: async () => {
        calls += 1;
        if (calls === 1) throw new ProviderExecutionError({ code: "RATE_LIMIT", message: "retry", retryable: true, providerId: "transient", statusCode: 429 });
        return { type: "completed", output: { ok: true } };
      },
      closeSession: async () => undefined,
    };
    const tools: ToolRegistryPort = { specificationsFor: () => [], execute: async () => { throw new Error("unexpected"); } };
    const retries: number[] = [];
    const output = await new AgentExecutor(provider, tools, { maxRetries: 1, retryBackoffMs: 0, sleep: async () => undefined }).execute({
      principal: principal("DEVELOPER", "developer"), agent: agent("DEVELOPER", "developer"), workspacePath: process.cwd(), prompt: "work", context: {}, requiredCapabilities: ["structuredOutput"], outputSchema: z.object({ ok: z.boolean() }), outputName: "result", outputJsonSchema: { type: "object" }, onReceipt: async () => undefined, onRetry: async (_error, retry) => { retries.push(retry); },
    });
    expect(output.value).toEqual({ ok: true });
    expect(output.retryCount).toBe(1);
    expect(output.attempts.map((attempt) => attempt.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(retries).toEqual([1]);
  });

  it("uses an in-session corrective turn for malformed structured output", async () => {
    const feedback: Array<string | undefined> = [];
    const provider: AgentProvider = {
      id: "malformed",
      capabilities: () => allRequired,
      createSession: async () => ({ id: "session", providerId: "malformed" }),
      execute: async (_session, request) => {
        feedback.push(request.validationFeedback);
        return { type: "completed", output: feedback.length === 1 ? { wrong: true } : { ok: true } };
      },
      closeSession: async () => undefined,
    };
    const tools: ToolRegistryPort = { specificationsFor: () => [], execute: async () => { throw new Error("unexpected"); } };
    const output = await new AgentExecutor(provider, tools, { maxRetries: 1 }).execute({
      principal: principal("DEVELOPER", "developer"), agent: agent("DEVELOPER", "developer"), workspacePath: process.cwd(), prompt: "work", context: {}, requiredCapabilities: ["structuredOutput"], outputSchema: z.object({ ok: z.boolean() }), outputName: "result", outputJsonSchema: { type: "object" }, onReceipt: async () => undefined,
    });
    expect(output.value).toEqual({ ok: true });
    expect(feedback[0]).toBeUndefined();
    expect(feedback[1]).toMatch(/validation failed/iu);
  });

  it("aborts and classifies a provider timeout", async () => {
    let aborted = false;
    const provider: AgentProvider = {
      id: "hanging",
      capabilities: () => allRequired,
      createSession: async () => ({ id: "session", providerId: "hanging" }),
      execute: async (_session, _request, options) => await new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); })),
      closeSession: async () => undefined,
    };
    const tools: ToolRegistryPort = { specificationsFor: () => [], execute: async () => { throw new Error("unexpected"); } };
    await expect(new AgentExecutor(provider, tools, { timeoutMs: 20, maxRetries: 0 }).execute({
      principal: principal("DEVELOPER", "developer"), agent: agent("DEVELOPER", "developer"), workspacePath: process.cwd(), prompt: "work", context: {}, requiredCapabilities: ["structuredOutput"], outputSchema: z.object({ ok: z.boolean() }), outputName: "result", outputJsonSchema: { type: "object" }, onReceipt: async () => undefined,
    })).rejects.toMatchObject({ record: { code: "TIMEOUT" } });
    expect(aborted).toBe(true);
  });
});
