import {
  ProviderErrorRecordSchema,
  type ProviderErrorCode,
  type ProviderErrorRecord,
} from "./schemas.js";
import { redactSecrets } from "./redaction.js";

export class ProviderExecutionError extends Error {
  public readonly record: ProviderErrorRecord;

  public constructor(input: {
    code: ProviderErrorCode;
    message: string;
    retryable: boolean;
    providerId: string;
    statusCode?: number;
    cause?: unknown;
  }) {
    const safe = redactSecrets(input.message);
    super(`[${input.code}] ${safe}`, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "ProviderExecutionError";
    this.record = ProviderErrorRecordSchema.parse({
      code: input.code,
      message: safe,
      retryable: input.retryable,
      providerId: input.providerId,
      ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    });
  }
}

export function providerErrorRecord(error: unknown, providerId: string): ProviderErrorRecord {
  if (error instanceof ProviderExecutionError) return error.record;
  return ProviderErrorRecordSchema.parse({
    code: "UNKNOWN",
    message: redactSecrets(error instanceof Error ? error.message : String(error)),
    retryable: false,
    providerId,
  });
}
