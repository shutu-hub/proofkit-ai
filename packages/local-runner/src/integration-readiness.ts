import { IntegrationReadinessCheckSchema, type IntegrationReadinessCheck } from "@proofkit/contracts";

// Environment names identify credentials; ordinary endpoint URLs, scope names
// and source paths must remain usable as provenance. Connectors remain trusted
// local code and must never return secrets in the first place.
const CREDENTIAL_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|AUTHORIZATION|COOKIE|AUTH)(?:_|$)/i;

export function readinessCredentialValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => CREDENTIAL_NAME.test(name) && Boolean(value))
    .map(([, value]) => value!);
}

/** Validate before scrubbing so malformed or oversized checks cannot claim readiness. */
export function sanitizeReadinessCheck(input: unknown, credentials: readonly string[]): IntegrationReadinessCheck {
  const check = IntegrationReadinessCheckSchema.parse(input);
  const values = [...new Set(credentials)].filter(Boolean).sort((left, right) => right.length - left.length);
  const pattern = values.length ? new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : undefined;
  const scrub = (value: string): string => {
    let safe = pattern ? value.replace(pattern, "[REDACTED]") : value;
    safe = safe.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
    return safe.replace(/\b(authorization|cookie|set-cookie|password|passwd|secret|token|access[_-]?key|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]");
  };
  const evidence: IntegrationReadinessCheck["evidence"] = {};
  for (const [index, [key, value]] of Object.entries(check.evidence).entries()) {
    // Keep keys bounded without exposing their original contents. Refuse a
    // collision rather than silently overwrite an independent evidence fact.
    const safeKey = scrub(key) === key ? key : `redacted-key-${index + 1}`;
    if (Object.hasOwn(evidence, safeKey)) throw new Error("Readiness evidence keys collide after redaction");
    Object.defineProperty(evidence, safeKey, { enumerable: true, configurable: true, writable: true,
      value: typeof value === "string" ? scrub(value)
        : typeof value === "number" && values.includes(String(value)) ? "[REDACTED]" : value });
  }
  return IntegrationReadinessCheckSchema.parse({
    passed: check.passed,
    message: scrub(check.message),
    evidence,
    issues: check.issues?.map((issue) => ({ code: scrub(issue.code), guidance: scrub(issue.guidance) })),
  });
}
