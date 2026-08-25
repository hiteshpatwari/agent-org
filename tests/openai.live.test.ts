import { OpenAIProvider } from "@agent-org/providers";
import { describe, expect, it } from "vitest";

import { principal } from "./helpers.js";

describe("OpenAIProvider live integration", () => {
  it.runIf(process.env.OPENAI_LIVE_TEST === "1")(
    "returns provider-neutral structured output",
    async () => {
      const provider = new OpenAIProvider();
      const session = await provider.createSession({
        principal: principal("DEVELOPER", "developer"),
        role: "DEVELOPER",
      });
      const result = await provider.execute(session, {
        principal: principal("DEVELOPER", "developer"),
        role: "DEVELOPER",
        mission: "Return the requested structured value.",
        input: "Return ok true.",
        context: {},
        tools: [],
        requiredCapabilities: ["structuredOutput"],
        expectedOutput: {
          name: "smoke_result",
          jsonSchema: {
            type: "object",
            additionalProperties: false,
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
        },
      });
      expect(result).toMatchObject({ type: "completed", output: { ok: true } });
      await provider.closeSession(session);
    },
    60_000,
  );
});
