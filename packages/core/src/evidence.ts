import type { ExecutionReceipt, Review, Task, Verification } from "./schemas.js";
import { InvalidTransitionError } from "./errors.js";

function referencedReceipts(ids: string[], receipts: ExecutionReceipt[]): ExecutionReceipt[] {
  const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const selected = ids.map((id) => byId.get(id));
  if (selected.some((receipt) => !receipt)) {
    throw new InvalidTransitionError("Evidence references an unknown execution receipt.");
  }
  return selected as ExecutionReceipt[];
}

function assertScoped(
  task: Task,
  actorId: string,
  receipts: ExecutionReceipt[],
): void {
  if (receipts.some((receipt) => receipt.taskId !== task.id || receipt.agentId !== actorId)) {
    throw new InvalidTransitionError("Evidence receipt provenance does not match the task actor.");
  }
  const iteration = task.iteration ?? 0;
  if (receipts.some((receipt) => receipt.iteration !== undefined && receipt.iteration !== iteration)) {
    throw new InvalidTransitionError("Evidence receipt belongs to a stale task iteration.");
  }
}

export function assertVerificationEvidence(
  task: Task,
  verification: Verification,
  receipts: ExecutionReceipt[],
): void {
  const selected = referencedReceipts(verification.evidenceReceiptIds, receipts);
  assertScoped(task, verification.testerId, selected);
  if (verification.decision === "PASS") {
    if (verification.tests.some((test) => test.status !== "PASSED") || verification.blockers.length > 0 || verification.requestedNextAction !== "REVIEW") {
      throw new InvalidTransitionError("Passing verification cannot contain failed tests or blockers and must request review.");
    }
    const passingTest = selected.some(
      (receipt) =>
        receipt.toolName === "shell.execute" && receipt.status === "SUCCEEDED" && receipt.exitCode === 0,
    );
    if (!passingTest) {
      throw new InvalidTransitionError("Passing verification requires a successful test command receipt.");
    }
    for (const commandId of task.verificationCommandIds ?? []) {
      if (!selected.some((receipt) => receipt.toolName === "shell.execute" && receipt.status === "SUCCEEDED" && receipt.exitCode === 0 && receipt.input.commandId === commandId)) {
        throw new InvalidTransitionError(`Passing verification requires successful command ${commandId}.`);
      }
    }
    if (task.workspaceStateHash && selected.some((receipt) => receipt.workspaceStateHash !== task.workspaceStateHash)) {
      throw new InvalidTransitionError("Verification evidence does not match the current workspace state.");
    }
  }
}

export function assertReviewEvidence(
  task: Task,
  review: Review,
  receipts: ExecutionReceipt[],
): void {
  const selected = referencedReceipts(review.evidenceReceiptIds, receipts);
  assertScoped(task, review.reviewerId, selected);
  if (review.decision === "APPROVE") {
    if (review.blockers.length > 0 || review.requestedNextAction !== "ACCEPT" || review.findings.some((finding) => ["HIGH", "CRITICAL"].includes(finding.severity))) {
      throw new InvalidTransitionError("Approved review cannot contain blocking findings and must request acceptance.");
    }
    const hasDiff = selected.some(
      (receipt) => {
        if (receipt.toolName !== "git.diff" || receipt.status !== "SUCCEEDED") return false;
        if (typeof receipt.output !== "object" || receipt.output === null || !("stdout" in receipt.output)) {
          return false;
        }
        return typeof receipt.output.stdout === "string" && receipt.output.stdout.trim().length > 0;
      },
    );
    if (!hasDiff) throw new InvalidTransitionError("Approval requires a successful Git diff receipt.");
    if (task.workspaceStateHash && selected.some((receipt) => receipt.workspaceStateHash !== task.workspaceStateHash)) {
      throw new InvalidTransitionError("Review evidence does not match the current workspace state.");
    }
  }
}
