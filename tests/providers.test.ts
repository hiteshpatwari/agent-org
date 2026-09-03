import {
  UnsupportedCapabilityError,
  assertProviderCapabilities,
  type AgentExecutionRequest,
  type AgentProvider,
  type ProviderCapabilities,
  type ProviderSession,
} from "@agent-org/core";
import { AnthropicProvider, MockProvider, OpenAIProvider, normalizeAnthropicError, normalizeOpenAIError } from "@agent-org/providers";
import { describe, expect, it } from "vitest";

import { principal } from "./helpers.js";

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
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
    ...overrides,
  };
}

function request(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    principal: principal("DEVELOPER", "developer"),
    role: "DEVELOPER",
    mission: "Implement the task.",
    input: "Implement sum.",
    context: {
      acceptanceCriteria: [
        { id: "AC-TEST", text: "Tests pass" },
        { id: "AC-DIFF", text: "Diff scoped" },
      ],
    },
    tools: [
      {
        name: "filesystem.write",
        description: "Write a file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    ],
    requiredCapabilities: ["structuredOutput", "toolCalling"],
    expectedOutput: { name: "result", jsonSchema: { type: "object" } },
    ...overrides,
  };
}

describe("MockProvider", () => {
  it("uses the neutral tool-call protocol and returns structured output", async () => {
    const provider = new MockProvider();
    const session = await provider.createSession({
      principal: principal("DEVELOPER", "developer"),
      role: "DEVELOPER",
    });
    const first = await provider.execute(session, request());
    expect(first.type).toBe("tool_calls");
    if (first.type !== "tool_calls") throw new Error("Expected tool calls.");
    expect(first.calls[0]?.name).toBe("filesystem.write");
    const second = await provider.execute(
      session,
      request({
        toolResults: [
          {
            callId: first.calls[0]?.id ?? "missing",
            receiptId: "RCT-1",
            status: "SUCCEEDED",
            output: { bytesWritten: 42 },
          },
        ],
      }),
    );
    expect(second.type).toBe("completed");
    if (second.type !== "completed") throw new Error("Expected completion.");
    expect(second.output).toMatchObject({ status: "SUCCEEDED", evidenceReceiptIds: ["RCT-1"] });
    await provider.closeSession(session);
  });
});

describe("OpenAIProvider", () => {
  it("normalizes quota, rate-limit, and authentication failures without raw secrets", () => {
    expect(normalizeOpenAIError(Object.assign(new Error("no credits remaining"), { status: 429 })).record).toMatchObject({ code: "QUOTA_EXHAUSTED", retryable: false });
    expect(normalizeOpenAIError(Object.assign(new Error("too many requests"), { status: 429 })).record).toMatchObject({ code: "RATE_LIMIT", retryable: true });
    const fakeKey = ["sk", "proj", "secretvalue123"].join("-");
    const authentication = normalizeOpenAIError(Object.assign(new Error(`incorrect API key ${fakeKey}`), { status: 401 })).record;
    expect(authentication).toMatchObject({ code: "AUTHENTICATION", retryable: false });
    expect(authentication.message).not.toContain(fakeKey);
  });

  it("maps Responses API function calls and structured output without leaking SDK types", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      create: async (parameters: Record<string, unknown>): Promise<unknown> => {
        calls.push(parameters);
        if (calls.length === 1) {
          return {
            id: "resp-1",
            model: "fake-model",
            output: [
              {
                type: "function_call",
                call_id: "call-1",
                name: "filesystem.write",
                arguments: JSON.stringify({ path: "src/sum.ts", content: "export const sum = () => 0;" }),
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
        }
        return {
          id: "resp-2",
          model: "fake-model",
          output_text: JSON.stringify({ ok: true }),
          output: [],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        };
      },
    };
    const provider = new OpenAIProvider({ client, model: "fake-model" });
    const session = await provider.createSession({
      principal: principal("DEVELOPER", "developer"),
      role: "DEVELOPER",
    });
    const first = await provider.execute(session, request());
    expect(first).toMatchObject({
      type: "tool_calls",
      calls: [{ id: "call-1", name: "filesystem.write" }],
    });
    const second = await provider.execute(
      session,
      request({
        toolResults: [
          { callId: "call-1", receiptId: "RCT-1", status: "SUCCEEDED", output: { ok: true } },
        ],
      }),
    );
    expect(second).toMatchObject({ type: "completed", output: { ok: true } });
    expect(calls[1]).toMatchObject({ previous_response_id: "resp-1" });
    expect(calls[1]?.input).toEqual([
      expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
    ]);
    await provider.closeSession(session);
  });
});

describe("AnthropicProvider", () => {
  it("maps neutral tool calls, tool results, structured output, and usage", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = { messages: { create: async (parameters: Record<string, unknown>): Promise<unknown> => { calls.push(parameters); return calls.length === 1 ? { model: "claude-test", content: [{ type: "tool_use", id: "tool-1", name: "filesystem.write", input: { path: "src/sum.ts", content: "export const sum = () => 0;" } }], usage: { input_tokens: 10, output_tokens: 5 } } : { model: "claude-test", content: [{ type: "text", text: JSON.stringify({ ok: true }) }], usage: { input_tokens: 4, output_tokens: 2 } }; } } };
    const provider = new AnthropicProvider({ client, model: "claude-test" });
    const session = await provider.createSession({ principal: principal("DEVELOPER", "developer"), role: "DEVELOPER" });
    const first = await provider.execute(session, request());
    expect(first).toMatchObject({ type: "tool_calls", calls: [{ id: "tool-1", name: "filesystem.write" }] });
    const second = await provider.execute(session, request({ toolResults: [{ callId: "tool-1", receiptId: "RCT-1", status: "SUCCEEDED", output: { ok: true } }] }));
    expect(second).toMatchObject({ type: "completed", output: { ok: true }, usage: { inputTokens: 4, outputTokens: 2 } });
    expect(calls[1]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user" })]));
  });

  it("normalizes authentication and rate-limit failures without secrets", () => {
    const fakeKey = ["sk", "ant", "secretvalue123"].join("-");
    expect(normalizeAnthropicError(Object.assign(new Error(`invalid api key ${fakeKey}`), { status: 401 })).record).toMatchObject({ code: "AUTHENTICATION" });
    expect(normalizeAnthropicError(Object.assign(new Error("rate limit"), { status: 429 })).record).toMatchObject({ code: "RATE_LIMIT", retryable: true });
  });
});

describe("provider capabilities", () => {
  it("rejects unsupported workflow requirements before session creation", () => {
    const provider: AgentProvider = {
      id: "limited",
      capabilities: () => capabilities({ structuredOutput: false }),
      createSession: async (): Promise<ProviderSession> => ({ id: "s", providerId: "limited" }),
      execute: async () => ({ type: "completed", output: {} }),
      closeSession: async () => undefined,
    };
    expect(() => assertProviderCapabilities(provider, ["structuredOutput"])).toThrow(
      UnsupportedCapabilityError,
    );
  });
});
