export function redactSecrets(value: string): string {
  return value
    .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{8,}/gu, "[REDACTED]")
    .replace(/(OPENAI_API_KEY\s*[=:]\s*)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|secret)["']?\s*[:=]\s*["'])[^"']{8,}(["'])/giu, "$1[REDACTED]$2")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED PRIVATE KEY]");
}

export function redactUnknown<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactUnknown(item)])) as T;
  }
  return value;
}

export function containsSecret(value: string): boolean { return redactSecrets(value) !== value; }
