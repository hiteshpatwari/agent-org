import type {
  AgentProvider,
  ExecutionReceipt,
  NeutralToolCall,
  ProviderCapabilities,
  ToolRegistryPort,
} from "@agent-org/core";
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
});
