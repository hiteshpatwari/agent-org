import type { AgentProvider, ProviderCapability } from "./ports.js";

export class UnsupportedCapabilityError extends Error {
  public constructor(providerId: string, missing: ProviderCapability[]) {
    super(`Provider ${providerId} is missing required capabilities: ${missing.join(", ")}.`);
    this.name = "UnsupportedCapabilityError";
  }
}

export function assertProviderCapabilities(
  provider: AgentProvider,
  required: ProviderCapability[],
): void {
  const capabilities = provider.capabilities();
  const missing = required.filter((capability) => !capabilities[capability]);
  if (missing.length > 0) throw new UnsupportedCapabilityError(provider.id, missing);
}
