import { ChiefPlanPayloadSchema, ReviewPayloadSchema, VerificationPayloadSchema, WorkerPayloadSchema } from "@agent-org/core";
import { z } from "zod";
import { describe, expect, it } from "vitest";

describe("canonical structured output schemas", () => {
  it("generates provider JSON Schema directly from each canonical Zod contract", () => {
    for (const schema of [ChiefPlanPayloadSchema, WorkerPayloadSchema, VerificationPayloadSchema, ReviewPayloadSchema]) {
      const generated = z.toJSONSchema(schema) as { type?: string; additionalProperties?: boolean; properties?: Record<string, unknown> };
      expect(generated.type).toBe("object");
      expect(generated.additionalProperties).toBe(false);
      expect(Object.keys(generated.properties ?? {}).length).toBeGreaterThan(3);
    }
  });
});
