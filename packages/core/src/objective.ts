import type { ActorPrincipal, Objective, Task } from "./schemas.js";
import { AuthorizationError } from "./authorization.js";
import { InvalidTransitionError } from "./errors.js";

export function completeObjective(
  objective: Objective,
  tasks: Task[],
  principal: ActorPrincipal,
  unresolvedApprovalCount: number,
  now = new Date().toISOString(),
): Objective {
  if (principal.role !== "CHIEF_ENGINEER" || principal.objectiveId !== objective.id) {
    throw new AuthorizationError("Only the scoped Chief Engineer can complete an objective.");
  }
  const requiredTasks = tasks.filter((task) => objective.taskIds.includes(task.id));
  if (requiredTasks.length !== objective.taskIds.length) {
    throw new InvalidTransitionError("Objective task graph is incomplete.");
  }
  if (requiredTasks.some((task) => task.status !== "COMPLETED")) {
    throw new InvalidTransitionError("All required tasks must be completed before the objective.");
  }
  if (unresolvedApprovalCount > 0) {
    throw new InvalidTransitionError("Pending human approvals prevent objective completion.");
  }
  return { ...objective, status: "COMPLETED", updatedAt: now, completedAt: now };
}
