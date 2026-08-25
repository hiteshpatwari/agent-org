import { randomUUID } from "node:crypto";

import type {
  AgentExecutionRequest,
  AgentProvider,
  ActorPrincipal,
  ProviderCapabilities,
  ProviderSession,
  ProviderTurnResult,
  Role,
} from "@agent-org/core";

interface MockSessionState {
  role: Role;
}

function criteriaIds(context: Record<string, unknown>): string[] {
  const raw = context.acceptanceCriteria;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item === "object" && item !== null && "id" in item && typeof item.id === "string") {
      return [item.id];
    }
    return [];
  });
}

function resultExitCode(output: unknown): number | undefined {
  if (typeof output !== "object" || output === null || !("exitCode" in output)) return undefined;
  return typeof output.exitCode === "number" ? output.exitCode : undefined;
}

export class MockProvider implements AgentProvider {
  public readonly id = "mock";
  private readonly sessions = new Map<string, MockSessionState>();

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
      streaming: false,
      reasoning: false,
      imageInput: false,
    };
  }

  public async createSession(context: { principal: ActorPrincipal; role: Role; modelPreference?: string }): Promise<ProviderSession> {
    const session = { id: `mock-session-${randomUUID()}`, providerId: this.id };
    this.sessions.set(session.id, { role: context.role });
    return Promise.resolve(session);
  }

  public async execute(
    session: ProviderSession,
    request: AgentExecutionRequest,
  ): Promise<ProviderTurnResult> {
    const state = this.sessions.get(session.id);
    if (!state) throw new Error(`Unknown mock session ${session.id}.`);

    if (!request.toolResults) {
      if (state.role === "DEVELOPER") {
        return Promise.resolve({
          type: "tool_calls",
          model: "deterministic",
          calls: [
            {
              id: "mock-write-sum",
              name: "filesystem.write",
              input: {
                path: "src/sum.ts",
                content:
                  "/** Return the arithmetic sum of two numbers. */\nexport function sum(a: number, b: number): number {\n  return a + b;\n}\n",
              },
            },
          ],
        });
      }
      if (state.role === "TESTER") {
        return Promise.resolve({
          type: "tool_calls",
          model: "deterministic",
          calls: [
            { id: "mock-run-tests", name: "shell.execute", input: { commandId: "sample-test" } },
          ],
        });
      }
      if (state.role === "REVIEWER") {
        return Promise.resolve({
          type: "tool_calls",
          model: "deterministic",
          calls: [
            { id: "mock-git-status", name: "git.status", input: {} },
            { id: "mock-git-diff", name: "git.diff", input: {} },
            { id: "mock-read-sum", name: "filesystem.read", input: { path: "src/sum.ts" } },
          ],
        });
      }
      throw new Error(`MockProvider has no scenario for role ${state.role}.`);
    }

    const receiptIds = request.toolResults.map((result) => result.receiptId);
    if (state.role === "DEVELOPER") {
      return Promise.resolve({
        type: "completed",
        model: "deterministic",
        output: {
          status: request.toolResults.every((item) => item.status === "SUCCEEDED") ? "SUCCEEDED" : "FAILED",
          summary: "Implemented the requested TypeScript sum function.",
          filesChanged: ["src/sum.ts"],
          commandsExecuted: [],
          evidenceReceiptIds: receiptIds,
          assumptions: [],
          risks: [],
          questions: [],
          artifacts: [],
        },
      });
    }
    if (state.role === "TESTER") {
      const pass = request.toolResults.every(
        (item) => item.status === "SUCCEEDED" && resultExitCode(item.output) === 0,
      );
      return Promise.resolve({
        type: "completed",
        model: "deterministic",
        output: {
          decision: pass ? "PASS" : "FAIL",
          summary: pass ? "The provided Node test suite passed." : "The provided Node test suite failed.",
          tests: [{ name: "node --test test/sum.test.mjs", status: pass ? "PASSED" : "FAILED" }],
          requirementsChecked: criteriaIds(request.context),
          evidenceReceiptIds: receiptIds,
          risks: [],
        },
      });
    }
    if (state.role === "REVIEWER") {
      const successful = request.toolResults.every((item) => item.status === "SUCCEEDED");
      return Promise.resolve({
        type: "completed",
        model: "deterministic",
        output: {
          decision: successful ? "APPROVE" : "BLOCK",
          summary: successful
            ? "The implementation is minimal, typed, independently tested, and matches the requested diff."
            : "Required review evidence could not be inspected.",
          findings: [],
          requirementsChecked: criteriaIds(request.context),
          evidenceReceiptIds: receiptIds,
          unresolvedRisks: [],
        },
      });
    }
    throw new Error(`MockProvider cannot complete role ${state.role}.`);
  }

  public async closeSession(session: ProviderSession): Promise<void> {
    this.sessions.delete(session.id);
    await Promise.resolve();
  }
}
