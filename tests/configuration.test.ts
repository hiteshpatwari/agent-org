import path from "node:path";

import { loadConfiguration } from "@agent-org/runtime";
import { describe, expect, it } from "vitest";

describe("real-provider configuration", () => {
  it("loads provider policies and validates every agent preference", async () => {
    const configuration = await loadConfiguration(path.resolve(import.meta.dirname, ".."));
    expect(configuration.organization.providers.openai).toMatchObject({ type: "openai", defaultModel: "gpt-5.4-mini", maxRetries: 2 });
    expect(configuration.organization.providers.mock).toMatchObject({ type: "mock", defaultModel: "deterministic" });
    for (const agent of configuration.agents.values()) {
      expect(configuration.organization.providers[agent.providerPreference ?? "mock"]).toBeDefined();
    }
  });
});
