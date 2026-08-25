import {
  HumanApprovalRequiredError,
  requireResolvedApproval,
  requestApproval,
  resolveApproval,
} from "@agent-org/core";
import { describe, expect, it } from "vitest";

import { principal } from "./helpers.js";

describe("human approval gates", () => {
  it("requires an Engineering Manager decision", () => {
    const request = requestApproval(
      principal("CHIEF_ENGINEER", "chief"),
      "DEPLOY_PRODUCTION",
      "Production deployment",
      "HIGH",
    );
    expect(() => requireResolvedApproval(request)).toThrow(HumanApprovalRequiredError);
    expect(() => resolveApproval(request, principal("REVIEWER", "reviewer"), true)).toThrow();
    const approved = resolveApproval(
      request,
      principal("ENGINEERING_MANAGER", "human"),
      true,
    );
    expect(() => requireResolvedApproval(approved)).not.toThrow();
  });
});
