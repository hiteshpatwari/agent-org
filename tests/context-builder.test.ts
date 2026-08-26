import { AgentContextBuilder } from "@agent-org/runtime";
import { describe, expect, it } from "vitest";

import { agent, implementationResult, ledger, receipt, review, task, verification } from "./helpers.js";

const workspace = { hash: "a".repeat(64), files: [{ path: "src/sum.ts", sha256: "b".repeat(64), bytes: 20 }] };

describe("role-specific agent context", () => {
  it("keeps persuasive developer reasoning out of independent tester and reviewer context", () => {
    const currentTask = task({ status: "REVIEWING", implementerId: "developer", verifierId: "tester", reviewerId: "reviewer", iteration: 0, workspaceStateHash: workspace.hash });
    const state = ledger({
      tasks: [currentTask],
      results: [implementationResult({ summary: "PERSUASIVE_DEVELOPER_REASONING", iteration: 0, workspaceStateHash: workspace.hash })],
      verifications: [verification({ iteration: 0, workspaceStateHash: workspace.hash })],
      reviews: [review({ decision: "REQUEST_CHANGES", summary: "Independent defect", findings: [{ severity: "HIGH", summary: "Fix it", evidence: [] }], requestedNextAction: "REWORK", iteration: 0, workspaceStateHash: workspace.hash })],
      receipts: [receipt({ agentId: "reviewer", toolName: "git.diff", iteration: 0, workspaceStateHash: workspace.hash })],
    });
    const builder = new AgentContextBuilder();
    const tester = builder.build({ role: "TESTER", agent: agent("TESTER", "tester"), ledger: state, task: currentTask, workspace });
    const reviewer = builder.build({ role: "REVIEWER", agent: agent("REVIEWER", "reviewer"), ledger: state, task: currentTask, workspace });
    expect(JSON.stringify(tester)).not.toContain("PERSUASIVE_DEVELOPER_REASONING");
    expect(JSON.stringify(reviewer)).not.toContain("PERSUASIVE_DEVELOPER_REASONING");
    expect(JSON.stringify(reviewer)).toContain("intentionally excluded");
  });

  it("supplies prior independent findings to a developer only during rework", () => {
    const currentTask = task({ status: "READY", reworkCount: 1, iteration: 1 });
    const state = ledger({ tasks: [currentTask], reviews: [review({ decision: "REQUEST_CHANGES", summary: "Independent defect", findings: [{ severity: "HIGH", summary: "Correct boundary", evidence: [] }], requestedNextAction: "REWORK" })] });
    const context = new AgentContextBuilder().build({ role: "DEVELOPER", agent: agent("DEVELOPER", "developer"), ledger: state, task: currentTask, workspace });
    expect(JSON.stringify(context)).toContain("Correct boundary");
  });
});
