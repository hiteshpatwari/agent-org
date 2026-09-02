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

export interface MockProviderOptions {
  reviewDecisions?: Array<"APPROVE" | "REQUEST_CHANGES" | "BLOCK">;
  verificationDecisions?: Array<"PASS" | "FAIL" | "BLOCK">;
}

function objectiveId(context: Record<string, unknown>): string | undefined {
  const objective = context.objective;
  return typeof objective === "object" && objective !== null && "id" in objective && typeof objective.id === "string"
    ? objective.id
    : undefined;
}

function verificationCommandIds(context: Record<string, unknown>): string[] {
  const objective = context.objective;
  if (typeof objective === "object" && objective !== null && "verificationCommandIds" in objective && Array.isArray(objective.verificationCommandIds)) {
    const ids = objective.verificationCommandIds.filter((value): value is string => typeof value === "string");
    if (ids.length > 0) return ids;
  }
  return [objectiveId(context) === "OBJ-REAL-BUG-FIX" ? "real-bug-test" : "sample-test"];
}

function criteriaIds(context: Record<string, unknown>): string[] {
  const task = typeof context.task === "object" && context.task !== null ? context.task as Record<string, unknown> : undefined;
  const objective = typeof context.objective === "object" && context.objective !== null ? context.objective as Record<string, unknown> : undefined;
  const raw = task?.acceptanceCriteria ?? objective?.acceptanceCriteria ?? context.acceptanceCriteria;
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
  private reviewIndex = 0;
  private verificationIndex = 0;

  public constructor(private readonly options: MockProviderOptions = {}) {}

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
      if (state.role === "CHIEF_ENGINEER") {
        const rawObjective = request.context.objective;
        const objective = typeof rawObjective === "object" && rawObjective !== null ? rawObjective as Record<string, unknown> : {};
        const requirements = Array.isArray(objective.requirements) ? objective.requirements : [];
        const acceptance = Array.isArray(objective.acceptanceCriteria) ? objective.acceptanceCriteria : [];
        const ids = (items: unknown[]): string[] => items.flatMap((item) => typeof item === "object" && item !== null && "id" in item && typeof item.id === "string" ? [item.id] : []);
        return Promise.resolve({
          type: "completed",
          model: "deterministic",
          output: {
            title: typeof objective.title === "string" ? objective.title : "Planned engineering task",
            description: typeof objective.description === "string" ? objective.description : "Complete the objective.",
            requirementIds: ids(requirements),
            acceptanceCriterionIds: ids(acceptance),
            dependencies: [],
            assumptions: [],
            risks: [],
            blockers: [],
            requestedNextAction: "ASSIGN",
          },
        });
      }
      if (state.role === "DEVELOPER") {
        if (objectiveId(request.context) === "OBJ-REAL-BUG-FIX") {
          return Promise.resolve({
            type: "tool_calls",
            model: "deterministic",
            calls: [
              {
                id: "mock-write-parser",
                name: "filesystem.write",
                input: {
                  path: "src/order-parser.ts",
                  content: "export interface OrderLine { sku: string; quantity: number; unitPriceCents: number }\n\nexport function parseOrderLine(value: string): OrderLine {\n  const [sku, quantity, unitPriceCents] = value.split(',').map((part) => part.trim());\n  if (!sku || !quantity || !unitPriceCents) throw new Error('Order line must contain sku, quantity, and unit price.');\n  const parsedQuantity = Number(quantity);\n  const parsedPrice = Number(unitPriceCents);\n  if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) throw new Error('Quantity must be a positive integer.');\n  if (!Number.isInteger(parsedPrice) || parsedPrice < 0) throw new Error('Unit price must be non-negative cents.');\n  return { sku, quantity: parsedQuantity, unitPriceCents: parsedPrice };\n}\n",
                },
              },
              {
                id: "mock-write-pricing",
                name: "filesystem.write",
                input: {
                  path: "src/pricing.ts",
                  content: "import type { OrderLine } from './order-parser.ts';\n\nexport function subtotalCents(lines: OrderLine[]): number {\n  return lines.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0);\n}\n\nexport function loyaltyTotalCents(lines: OrderLine[], loyaltyPercent: number): number {\n  if (!Number.isFinite(loyaltyPercent) || loyaltyPercent < 0 || loyaltyPercent > 100) throw new Error('Loyalty percent must be between 0 and 100.');\n  return Math.round(subtotalCents(lines) * (100 - loyaltyPercent) / 100);\n}\n",
                },
              },
              {
                id: "mock-write-tests",
                name: "filesystem.write",
                input: {
                  path: "test/order.test.mjs",
                  content: "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { parseOrderLine } from '../src/order-parser.ts';\nimport { loyaltyTotalCents, subtotalCents } from '../src/pricing.ts';\n\ntest('parses trimmed order lines and totals quantity times cents', () => {\n  const lines = [parseOrderLine(' A, 2, 125 '), parseOrderLine('B,1,50')];\n  assert.equal(subtotalCents(lines), 300);\n});\n\ntest('rounds loyalty discounts once at the final total', () => {\n  assert.equal(loyaltyTotalCents([parseOrderLine('A,3,101')], 10), 273);\n});\n\ntest('rejects invalid quantity', () => assert.throws(() => parseOrderLine('A,0,100'), /Quantity/));\n",
                },
              },
            ],
          });
        }
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
          calls: verificationCommandIds(request.context).map((commandId, index) => ({ id: `mock-run-tests-${index + 1}`, name: "shell.execute", input: { commandId } })),
        });
      }
      if (state.role === "REVIEWER") {
        const readCalls = objectiveId(request.context) === "OBJ-REAL-BUG-FIX"
          ? [
              { id: "mock-read-parser", name: "filesystem.read", input: { path: "src/order-parser.ts" } },
              { id: "mock-read-pricing", name: "filesystem.read", input: { path: "src/pricing.ts" } },
              { id: "mock-read-order-tests", name: "filesystem.read", input: { path: "test/order.test.mjs" } },
            ]
          : [{ id: "mock-read-sum", name: "filesystem.read", input: { path: "src/sum.ts" } }];
        return Promise.resolve({
          type: "tool_calls",
          model: "deterministic",
          calls: [
            { id: "mock-git-status", name: "git.status", input: {} },
            { id: "mock-git-diff", name: "git.diff", input: {} },
            ...readCalls,
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
          summary: objectiveId(request.context) === "OBJ-REAL-BUG-FIX" ? "Corrected order parsing and pricing with regression tests." : "Implemented the requested TypeScript sum function.",
          filesChanged: objectiveId(request.context) === "OBJ-REAL-BUG-FIX" ? ["src/order-parser.ts", "src/pricing.ts", "test/order.test.mjs"] : ["src/sum.ts"],
          commandsExecuted: [],
          evidenceReceiptIds: receiptIds,
          assumptions: [],
          risks: [],
          questions: [],
          artifacts: [],
          blockers: [],
          requestedNextAction: request.toolResults.every((item) => item.status === "SUCCEEDED") ? "VERIFY" : "REWORK",
        },
      });
    }
    if (state.role === "TESTER") {
      const toolPass = request.toolResults.every(
        (item) => item.status === "SUCCEEDED" && resultExitCode(item.output) === 0,
      );
      const decision = this.options.verificationDecisions?.[this.verificationIndex++] ?? (toolPass ? "PASS" : "FAIL");
      const pass = decision === "PASS" && toolPass;
      return Promise.resolve({
        type: "completed",
        model: "deterministic",
        output: {
          decision: decision === "PASS" && !toolPass ? "FAIL" : decision,
          summary: pass ? "The provided Node test suite passed." : "The provided Node test suite failed.",
          tests: verificationCommandIds(request.context).map((name) => ({ name, status: pass ? "PASSED" as const : "FAILED" as const, details: null })),
          requirementsChecked: criteriaIds(request.context),
          evidenceReceiptIds: receiptIds,
          risks: [],
          blockers: [],
          requestedNextAction: decision === "BLOCK" ? "BLOCK" : pass ? "REVIEW" : "REWORK",
        },
      });
    }
    if (state.role === "REVIEWER") {
      const successful = request.toolResults.every((item) => item.status === "SUCCEEDED");
      const configured = this.options.reviewDecisions?.[this.reviewIndex++] ?? (successful ? "APPROVE" : "BLOCK");
      const decision = successful ? configured : "BLOCK";
      return Promise.resolve({
        type: "completed",
        model: "deterministic",
        output: {
          decision,
          summary: successful
            ? "The implementation is minimal, typed, independently tested, and matches the requested diff."
            : "Required review evidence could not be inspected.",
          findings: decision === "REQUEST_CHANGES" ? [{ severity: "HIGH", summary: "Scripted deterministic review requires one rework cycle.", evidence: receiptIds }] : [],
          requirementsChecked: criteriaIds(request.context),
          evidenceReceiptIds: receiptIds,
          producedEvidenceReceiptIds: receiptIds,
          observedEvidenceReceiptIds: [],
          unresolvedRisks: [],
          blockers: [],
          requestedNextAction: decision === "APPROVE" ? "ACCEPT" : decision === "REQUEST_CHANGES" ? "REWORK" : "BLOCK",
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
