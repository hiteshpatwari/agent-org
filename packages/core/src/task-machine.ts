import type {
  ActorPrincipal,
  Review,
  Task,
  TaskResult,
  TaskStatus,
  Verification,
  ExecutionReceipt,
} from "./schemas.js";
import { assertIndependentReviewer, assertIndependentTester, AuthorizationError } from "./authorization.js";
import { assertReviewEvidence, assertVerificationEvidence } from "./evidence.js";
import { InvalidTransitionError } from "./errors.js";

export type TaskCommand =
  | { type: "MARK_READY"; completedDependencyIds: string[] }
  | { type: "ASSIGN_IMPLEMENTER"; implementerId: string }
  | { type: "CLAIM_IMPLEMENTATION" }
  | { type: "SUBMIT_IMPLEMENTATION"; result: TaskResult; receipts?: ExecutionReceipt[] }
  | { type: "START_VERIFICATION"; verifierId: string }
  | { type: "SUBMIT_VERIFICATION"; verification: Verification; receipts: ExecutionReceipt[] }
  | { type: "START_REVIEW"; reviewerId: string }
  | { type: "SUBMIT_REVIEW"; review: Review; receipts: ExecutionReceipt[] }
  | { type: "ACCEPT"; verification: Verification; review: Review; validReceiptIds: string[] }
  | { type: "REJECT"; reason: string }
  | { type: "REOPEN"; implementerId: string }
  | { type: "BLOCK"; reason: string }
  | { type: "FAIL"; reason: string }
  | { type: "CANCEL"; reason: string };

const allowedRoles: Record<TaskCommand["type"], ActorPrincipal["role"][]> = {
  MARK_READY: ["CHIEF_ENGINEER"],
  ASSIGN_IMPLEMENTER: ["CHIEF_ENGINEER"],
  CLAIM_IMPLEMENTATION: ["DEVELOPER"],
  SUBMIT_IMPLEMENTATION: ["DEVELOPER"],
  START_VERIFICATION: ["CHIEF_ENGINEER"],
  SUBMIT_VERIFICATION: ["TESTER"],
  START_REVIEW: ["CHIEF_ENGINEER"],
  SUBMIT_REVIEW: ["REVIEWER"],
  ACCEPT: ["CHIEF_ENGINEER"],
  REJECT: ["CHIEF_ENGINEER"],
  REOPEN: ["CHIEF_ENGINEER"],
  BLOCK: ["CHIEF_ENGINEER", "REVIEWER"],
  FAIL: ["CHIEF_ENGINEER", "DEVELOPER", "TESTER"],
  CANCEL: ["CHIEF_ENGINEER"],
};

function requireState(task: Task, ...states: TaskStatus[]): void {
  if (!states.includes(task.status)) {
    throw new InvalidTransitionError(
      `${task.id} cannot transition via this command from ${task.status}; expected ${states.join(" or ")}.`,
    );
  }
}

function requireTaskPrincipal(task: Task, principal: ActorPrincipal): void {
  if (principal.taskId !== task.id || principal.objectiveId !== task.objectiveId) {
    throw new AuthorizationError("Actor principal is not scoped to this task.");
  }
}

function coverage(requiredIds: string[], checkedIds: string[]): boolean {
  return requiredIds.every((id) => checkedIds.includes(id));
}

export function transitionTask(
  task: Task,
  command: TaskCommand,
  principal: ActorPrincipal,
  now = new Date().toISOString(),
): Task {
  requireTaskPrincipal(task, principal);
  if (!allowedRoles[command.type].includes(principal.role)) {
    throw new AuthorizationError(`${principal.role} cannot execute ${command.type}.`);
  }

  const next: Task = { ...task, artifactIds: [...task.artifactIds], blockers: [...task.blockers], updatedAt: now };

  switch (command.type) {
    case "MARK_READY": {
      requireState(task, "PENDING");
      const missing = task.dependencies.filter((id) => !command.completedDependencyIds.includes(id));
      if (missing.length > 0) {
        throw new InvalidTransitionError(`Dependencies are incomplete: ${missing.join(", ")}.`);
      }
      next.status = "READY";
      return next;
    }
    case "ASSIGN_IMPLEMENTER": {
      requireState(task, "READY");
      if (task.implementerId && task.implementerId !== command.implementerId) {
        throw new InvalidTransitionError("Implementer assignment is immutable until rework is reopened.");
      }
      next.implementerId = command.implementerId;
      return next;
    }
    case "CLAIM_IMPLEMENTATION": {
      requireState(task, "READY");
      if (task.implementerId !== principal.agentId) {
        throw new AuthorizationError("Only the assigned implementer can claim this task.");
      }
      next.status = "IN_PROGRESS";
      return next;
    }
    case "SUBMIT_IMPLEMENTATION": {
      requireState(task, "IN_PROGRESS");
      if (task.implementerId !== principal.agentId || command.result.agentId !== principal.agentId) {
        throw new AuthorizationError("Implementation provenance does not match the assigned implementer.");
      }
      if (command.result.taskId !== task.id || command.result.runId !== principal.runId) {
        throw new AuthorizationError("Implementation result provenance conflicts with the execution context.");
      }
      if (command.result.status !== "SUCCEEDED") {
        next.status = command.result.status === "BLOCKED" ? "BLOCKED" : "FAILED";
        return next;
      }
      if (command.result.blockers.length > 0 || command.result.requestedNextAction !== "VERIFY") {
        throw new InvalidTransitionError("Successful implementation cannot contain blockers and must request verification.");
      }
      const iteration = task.iteration ?? 0;
      if (command.result.iteration !== undefined && command.result.iteration !== iteration) {
        throw new InvalidTransitionError("Implementation result belongs to a stale task iteration.");
      }
      if (task.workspaceStateHash && command.result.workspaceStateHash !== task.workspaceStateHash) {
        throw new InvalidTransitionError("Implementation result does not match the current workspace state.");
      }
      if (command.receipts) {
        const cited = command.receipts.filter((receipt) => command.result.evidenceReceiptIds.includes(receipt.id));
        const successfulWrites = cited.filter((receipt) => receipt.toolName === "filesystem.write" && receipt.status === "SUCCEEDED" && (receipt.iteration ?? iteration) === iteration);
        if (successfulWrites.length === 0) throw new InvalidTransitionError("Successful implementation requires a successful current-iteration write receipt.");
        const written = new Set(successfulWrites.flatMap((receipt) => Object.keys(receipt.contentHashes)));
        if (!command.result.filesChanged.every((file) => written.has(file))) {
          throw new InvalidTransitionError("Implementation filesChanged must be backed by successful write receipts.");
        }
      }
      next.resultId = command.result.id;
      next.status = "VERIFICATION_REQUIRED";
      return next;
    }
    case "START_VERIFICATION": {
      requireState(task, "VERIFICATION_REQUIRED");
      assertIndependentTester(task, command.verifierId);
      next.verifierId = command.verifierId;
      next.status = "VERIFYING";
      return next;
    }
    case "SUBMIT_VERIFICATION": {
      requireState(task, "VERIFYING");
      if (task.verifierId !== principal.agentId || command.verification.testerId !== principal.agentId) {
        throw new AuthorizationError("Verification provenance does not match the assigned tester.");
      }
      assertVerificationEvidence(task, command.verification, command.receipts);
      next.verificationId = command.verification.id;
      next.status = command.verification.decision === "PASS" ? "REVIEW_REQUIRED" : "CHANGES_REQUESTED";
      if (command.verification.decision === "BLOCK") next.status = "BLOCKED";
      return next;
    }
    case "START_REVIEW": {
      requireState(task, "REVIEW_REQUIRED");
      assertIndependentReviewer(task, command.reviewerId);
      next.reviewerId = command.reviewerId;
      next.status = "REVIEWING";
      return next;
    }
    case "SUBMIT_REVIEW": {
      requireState(task, "REVIEWING");
      assertIndependentReviewer(task, principal.agentId);
      if (task.reviewerId !== principal.agentId || command.review.reviewerId !== principal.agentId) {
        throw new AuthorizationError("Review provenance does not match the assigned reviewer.");
      }
      assertReviewEvidence(task, command.review, command.receipts);
      next.reviewId = command.review.id;
      next.status =
        command.review.decision === "APPROVE"
          ? "ACCEPTANCE_REQUIRED"
          : command.review.decision === "BLOCK"
            ? "BLOCKED"
            : "CHANGES_REQUESTED";
      return next;
    }
    case "ACCEPT": {
      requireState(task, "ACCEPTANCE_REQUIRED");
      if (command.verification.id !== task.verificationId || command.verification.decision !== "PASS") {
        throw new InvalidTransitionError("Acceptance requires the task's passing verification.");
      }
      if (command.review.id !== task.reviewId || command.review.decision !== "APPROVE") {
        throw new InvalidTransitionError("Acceptance requires the task's approved review.");
      }
      const iteration = task.iteration ?? 0;
      if (command.verification.iteration !== undefined && command.verification.iteration !== iteration || command.review.iteration !== undefined && command.review.iteration !== iteration) {
        throw new InvalidTransitionError("Acceptance evidence belongs to a stale task iteration.");
      }
      if (task.workspaceStateHash && (command.verification.workspaceStateHash !== task.workspaceStateHash || command.review.workspaceStateHash !== task.workspaceStateHash)) {
        throw new InvalidTransitionError("Acceptance evidence does not match the accepted workspace state.");
      }
      const criteria = task.acceptanceCriteria.map((item) => item.id);
      if (!coverage(criteria, command.verification.requirementsChecked)) {
        throw new InvalidTransitionError("Verification does not cover every acceptance criterion.");
      }
      if (!coverage(criteria, command.review.requirementsChecked)) {
        throw new InvalidTransitionError("Review does not cover every acceptance criterion.");
      }
      const cited = [...command.verification.evidenceReceiptIds, ...command.review.evidenceReceiptIds];
      if (!cited.every((id) => command.validReceiptIds.includes(id))) {
        throw new InvalidTransitionError("Acceptance evidence references an unknown receipt.");
      }
      next.status = "COMPLETED";
      next.completedAt = now;
      return next;
    }
    case "REJECT": {
      requireState(task, "ACCEPTANCE_REQUIRED");
      next.status = "CHANGES_REQUESTED";
      next.blockers.push(command.reason);
      return next;
    }
    case "REOPEN": {
      requireState(task, "CHANGES_REQUESTED", "BLOCKED", "FAILED");
      next.status = "READY";
      next.implementerId = command.implementerId;
      next.verifierId = undefined;
      next.reviewerId = undefined;
      next.resultId = undefined;
      next.verificationId = undefined;
      next.reviewId = undefined;
      if (task.maxRework !== undefined && task.reworkCount >= task.maxRework) {
        throw new InvalidTransitionError(`Task exhausted its ${task.maxRework} allowed rework cycles.`);
      }
      next.reworkCount += 1;
      next.iteration = (task.iteration ?? 0) + 1;
      next.workspaceStateHash = undefined;
      return next;
    }
    case "BLOCK": {
      requireState(
        task,
        "PENDING",
        "READY",
        "IN_PROGRESS",
        "VERIFICATION_REQUIRED",
        "VERIFYING",
        "REVIEW_REQUIRED",
        "REVIEWING",
        "ACCEPTANCE_REQUIRED",
        "CHANGES_REQUESTED",
      );
      next.status = "BLOCKED";
      next.blockers.push(command.reason);
      return next;
    }
    case "FAIL": {
      requireState(task, "IN_PROGRESS", "VERIFYING");
      next.status = "FAILED";
      next.blockers.push(command.reason);
      return next;
    }
    case "CANCEL": {
      if (["COMPLETED", "CANCELLED"].includes(task.status)) {
        throw new InvalidTransitionError(`Cannot cancel a ${task.status.toLowerCase()} task.`);
      }
      next.status = "CANCELLED";
      next.blockers.push(command.reason);
      return next;
    }
  }
}

export function validateTaskGraph(tasks: Task[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.dependencies.includes(task.id)) {
      throw new InvalidTransitionError(`${task.id} cannot depend on itself.`);
    }
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency)) {
        throw new InvalidTransitionError(`${task.id} references missing dependency ${dependency}.`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new InvalidTransitionError(`Task dependency cycle contains ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}
