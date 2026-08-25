import type { ActorPrincipal, AgentDefinition, AuthorityAction } from "./schemas.js";

export class AuthorizationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function authorize(
  principal: ActorPrincipal,
  definition: AgentDefinition,
  action: AuthorityAction,
): void {
  if (principal.agentId !== definition.id || principal.role !== definition.role) {
    throw new AuthorizationError("Actor principal does not match the trusted agent definition.");
  }
  if (!definition.permissions.actions.includes(action)) {
    throw new AuthorizationError(`${definition.id} is not authorized to perform ${action}.`);
  }
}

export function assertIndependentReviewer(
  task: { implementerId?: string | undefined },
  reviewerId: string,
): void {
  if (!task.implementerId) {
    throw new AuthorizationError("A task without an implementer cannot be reviewed.");
  }
  if (task.implementerId === reviewerId) {
    throw new AuthorizationError("The implementation agent cannot review its own work.");
  }
}

export function assertIndependentTester(
  task: { implementerId?: string | undefined },
  testerId: string,
): void {
  if (!task.implementerId) {
    throw new AuthorizationError("A task without an implementer cannot be verified.");
  }
  if (task.implementerId === testerId) {
    throw new AuthorizationError("The implementation agent cannot verify its own work.");
  }
}
