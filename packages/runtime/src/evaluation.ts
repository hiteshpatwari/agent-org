import { z } from "zod";

import type { DomainEvent, Ledger } from "@agent-org/core";

export const EvalExpectationsSchema = z.object({
  implementationCreated: z.boolean().optional(),
  testsExecuted: z.boolean().optional(),
  reviewOccurred: z.boolean().optional(),
  selfReviewOccurred: z.boolean().optional(),
  completionBeforeReview: z.boolean().optional(),
  unresolvedBlockersAtCompletion: z.number().int().nonnegative().optional(),
  completed: z.boolean().optional(),
  minimumReworkCount: z.number().int().nonnegative().optional(),
  latestEvidenceMatchesWorkspace: z.boolean().optional(),
});
export type EvalExpectations = z.infer<typeof EvalExpectationsSchema>;

export interface EvalResult { passed: boolean; assertions: Array<{ name: string; expected: unknown; actual: unknown; passed: boolean }> }

export function evaluateLedger(ledger: Ledger, events: DomainEvent[], expectations: EvalExpectations): EvalResult {
  const task = ledger.tasks[0];
  const currentVerification = ledger.verifications.find((item) => item.id === task?.verificationId);
  const currentReview = ledger.reviews.find((item) => item.id === task?.reviewId);
  const reviewRevision = events.findIndex((event) => event.type === "REVIEW_COMPLETED");
  const completionRevision = events.findIndex((event) => event.type === "TASK_COMPLETED");
  const values: Record<keyof EvalExpectations, unknown> = {
    implementationCreated: ledger.results.some((result) => result.status === "SUCCEEDED"),
    testsExecuted: ledger.receipts.some((receipt) => receipt.toolName === "shell.execute"),
    reviewOccurred: ledger.reviews.length > 0,
    selfReviewOccurred: Boolean(task && ledger.reviews.some((review) => review.taskId === task.id && review.reviewerId === task.implementerId)),
    completionBeforeReview: completionRevision >= 0 && (reviewRevision < 0 || completionRevision < reviewRevision),
    unresolvedBlockersAtCompletion: ledger.objective.status === "COMPLETED" ? ledger.tasks.reduce((sum, item) => sum + item.blockers.length, 0) : 0,
    completed: ledger.objective.status === "COMPLETED",
    minimumReworkCount: task?.reworkCount ?? 0,
    latestEvidenceMatchesWorkspace: Boolean(task?.workspaceStateHash && currentVerification?.workspaceStateHash === task.workspaceStateHash && currentReview?.workspaceStateHash === task.workspaceStateHash && currentVerification.iteration === task.iteration && currentReview.iteration === task.iteration),
  };
  const assertions = Object.entries(expectations).map(([name, expected]) => {
    const actual = values[name as keyof EvalExpectations];
    const passed = name === "minimumReworkCount" ? Number(actual) >= Number(expected) : actual === expected;
    return { name, expected, actual, passed };
  });
  return { passed: assertions.every((item) => item.passed), assertions };
}
