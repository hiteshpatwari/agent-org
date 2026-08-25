import {
  AuthorizationError,
  InvalidTransitionError,
  TaskResultSchema,
  WorkerPayloadSchema,
  assertIndependentReviewer,
  authorize,
  completeObjective,
  transitionTask,
  validateTaskGraph,
} from "@agent-org/core";
import { describe, expect, it } from "vitest";

import {
  agent,
  implementationResult,
  objective,
  principal,
  receipt,
  review,
  task,
  verification,
} from "./helpers.js";

describe("task state machine", () => {
  it("executes the complete evidence-gated workflow", () => {
    const chief = principal("CHIEF_ENGINEER", "chief");
    const developer = principal("DEVELOPER", "developer");
    const tester = principal("TESTER", "tester");
    const reviewer = principal("REVIEWER", "reviewer");
    const testReceipt = receipt();
    const diffReceipt = receipt({
      id: "RCT-DIFF",
      agentId: "reviewer",
      toolName: "git.diff",
      input: {},
      output: { stdout: "diff --git a/src/sum.ts b/src/sum.ts" },
      exitCode: 0,
    });

    let current = transitionTask(task(), { type: "MARK_READY", completedDependencyIds: [] }, chief);
    current = transitionTask(current, { type: "ASSIGN_IMPLEMENTER", implementerId: "developer" }, chief);
    current = transitionTask(current, { type: "CLAIM_IMPLEMENTATION" }, developer);
    current = transitionTask(
      current,
      { type: "SUBMIT_IMPLEMENTATION", result: implementationResult() },
      developer,
    );
    current = transitionTask(current, { type: "START_VERIFICATION", verifierId: "tester" }, chief);
    current = transitionTask(
      current,
      { type: "SUBMIT_VERIFICATION", verification: verification(), receipts: [testReceipt] },
      tester,
    );
    current = transitionTask(current, { type: "START_REVIEW", reviewerId: "reviewer" }, chief);
    current = transitionTask(
      current,
      { type: "SUBMIT_REVIEW", review: review(), receipts: [diffReceipt] },
      reviewer,
    );
    current = transitionTask(
      current,
      {
        type: "ACCEPT",
        verification: verification(),
        review: review(),
        validReceiptIds: [testReceipt.id, diffReceipt.id],
      },
      chief,
    );

    expect(current.status).toBe("COMPLETED");
    expect(current.implementerId).toBe("developer");
    expect(current.verifierId).toBe("tester");
    expect(current.reviewerId).toBe("reviewer");
  });

  it("rejects invalid state transitions", () => {
    expect(() =>
      transitionTask(task(), { type: "CLAIM_IMPLEMENTATION" }, principal("DEVELOPER", "developer")),
    ).toThrow(InvalidTransitionError);
  });

  it("rejects incomplete dependencies", () => {
    expect(() =>
      transitionTask(
        task({ dependencies: ["TASK-0"] }),
        { type: "MARK_READY", completedDependencyIds: [] },
        principal("CHIEF_ENGINEER", "chief"),
      ),
    ).toThrow(/Dependencies are incomplete/u);
  });

  it("rejects identity spoofing in a task result", () => {
    const developer = principal("DEVELOPER", "developer");
    const assigned = task({ status: "IN_PROGRESS", implementerId: "developer" });
    expect(() =>
      transitionTask(
        assigned,
        { type: "SUBMIT_IMPLEMENTATION", result: implementationResult({ agentId: "attacker" }) },
        developer,
      ),
    ).toThrow(AuthorizationError);
  });

  it("routes failed verification to rework", () => {
    const current = task({
      status: "VERIFYING",
      implementerId: "developer",
      verifierId: "tester",
    });
    const failedReceipt = receipt({ status: "FAILED", exitCode: 1 });
    const next = transitionTask(
      current,
      {
        type: "SUBMIT_VERIFICATION",
        verification: verification({ decision: "FAIL", evidenceReceiptIds: [failedReceipt.id] }),
        receipts: [failedReceipt],
      },
      principal("TESTER", "tester"),
    );
    expect(next.status).toBe("CHANGES_REQUESTED");
  });

  it("routes requested review changes to rework", () => {
    const current = task({
      status: "REVIEWING",
      implementerId: "developer",
      reviewerId: "reviewer",
    });
    const readReceipt = receipt({
      id: "RCT-READ",
      agentId: "reviewer",
      toolName: "filesystem.read",
      output: { content: "bad" },
    });
    const next = transitionTask(
      current,
      {
        type: "SUBMIT_REVIEW",
        review: review({ decision: "REQUEST_CHANGES", evidenceReceiptIds: [readReceipt.id] }),
        receipts: [readReceipt],
      },
      principal("REVIEWER", "reviewer"),
    );
    expect(next.status).toBe("CHANGES_REQUESTED");
  });

  it("rejects approval without a real diff receipt", () => {
    const current = task({ status: "REVIEWING", implementerId: "developer", reviewerId: "reviewer" });
    expect(() =>
      transitionTask(
        current,
        {
          type: "SUBMIT_REVIEW",
          review: review(),
          receipts: [receipt({ id: "RCT-DIFF", agentId: "reviewer" })],
        },
        principal("REVIEWER", "reviewer"),
      ),
    ).toThrow(/Git diff receipt/u);
  });

  it("rejects acceptance when criterion coverage is incomplete", () => {
    const current = task({
      status: "ACCEPTANCE_REQUIRED",
      implementerId: "developer",
      verifierId: "tester",
      reviewerId: "reviewer",
      verificationId: "VERIFY-1",
      reviewId: "REVIEW-1",
    });
    expect(() =>
      transitionTask(
        current,
        {
          type: "ACCEPT",
          verification: verification({ requirementsChecked: ["AC-TEST"] }),
          review: review(),
          validReceiptIds: ["RCT-TEST", "RCT-DIFF"],
        },
        principal("CHIEF_ENGINEER", "chief"),
      ),
    ).toThrow(/every acceptance criterion/u);
  });
});

describe("authorization and structured provenance", () => {
  it("enforces declared authority", () => {
    const definition = agent("DEVELOPER", "developer", ["SUBMIT_RESULT"]);
    expect(() => authorize(principal("DEVELOPER", "developer"), definition, "SUBMIT_RESULT")).not.toThrow();
    expect(() => authorize(principal("DEVELOPER", "developer"), definition, "ACCEPT_TASK")).toThrow(
      AuthorizationError,
    );
  });

  it("rejects self review in the domain layer", () => {
    expect(() => assertIndependentReviewer({ implementerId: "same" }, "same")).toThrow(
      /cannot review its own work/u,
    );
  });

  it("rejects provider-authored provenance fields", () => {
    expect(() =>
      WorkerPayloadSchema.parse({
        ...implementationResult(),
        taskId: "SPOOFED",
      }),
    ).toThrow();
    expect(() => TaskResultSchema.parse({ summary: "not structured" })).toThrow();
  });
});

describe("dependency graph and objective lifecycle", () => {
  it("rejects missing and cyclic dependencies", () => {
    expect(() => validateTaskGraph([task({ dependencies: ["MISSING"] })])).toThrow(/missing dependency/u);
    expect(() =>
      validateTaskGraph([
        task({ id: "A", dependencies: ["B"] }),
        task({ id: "B", dependencies: ["A"] }),
      ]),
    ).toThrow(/cycle/u);
  });

  it("completes an objective only after every required task", () => {
    const chief = principal("CHIEF_ENGINEER", "chief");
    expect(() => completeObjective(objective(), [task({ status: "READY" })], chief, 0)).toThrow(
      /must be completed/u,
    );
    expect(completeObjective(objective(), [task({ status: "COMPLETED" })], chief, 0).status).toBe(
      "COMPLETED",
    );
    expect(() => completeObjective(objective(), [task({ status: "COMPLETED" })], chief, 1)).toThrow(
      /Pending human approvals/u,
    );
  });
});
