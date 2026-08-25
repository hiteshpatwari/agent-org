import { randomUUID } from "node:crypto";

import type { ActorPrincipal, ApprovalRequest, Risk } from "./schemas.js";
import { AuthorizationError } from "./authorization.js";

export class HumanApprovalRequiredError extends Error {
  public constructor(public readonly request: ApprovalRequest) {
    super(`Human approval is required for ${request.action}.`);
    this.name = "HumanApprovalRequiredError";
  }
}

export function requestApproval(
  principal: ActorPrincipal,
  action: string,
  reason: string,
  risk: Risk,
  now = new Date().toISOString(),
): ApprovalRequest {
  return {
    id: `APR-${randomUUID()}`,
    runId: principal.runId,
    action,
    reason,
    risk,
    status: "PENDING",
    requestedBy: principal.agentId,
    createdAt: now,
  };
}

export function resolveApproval(
  request: ApprovalRequest,
  human: ActorPrincipal,
  approved: boolean,
  now = new Date().toISOString(),
): ApprovalRequest {
  if (human.role !== "ENGINEERING_MANAGER") {
    throw new AuthorizationError("Only the human Engineering Manager can resolve approval gates.");
  }
  if (request.status !== "PENDING") {
    throw new Error(`Approval ${request.id} is already resolved.`);
  }
  return {
    ...request,
    status: approved ? "APPROVED" : "DENIED",
    decidedBy: human.agentId,
    decidedAt: now,
  };
}

export function requireResolvedApproval(request: ApprovalRequest): void {
  if (request.status !== "APPROVED") throw new HumanApprovalRequiredError(request);
}
