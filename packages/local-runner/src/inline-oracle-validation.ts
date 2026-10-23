import type { TestCharter } from "@proofkit/contracts";

export type InlineOracleIssue = {
  code: "duplicate-name" | "registered-name-conflict" | "origin-disallowed" | "binding-invalid" | "current-id-missing";
  name?: string;
  scenario?: string;
};

/** Keep scope guidance and Mission admission on the same current-response binding rule. */
export function firstInlineOracleIssue(charter: TestCharter, registeredNames: ReadonlySet<string>, restrictOrigins: boolean, apiOrigins: readonly string[] = []): InlineOracleIssue | undefined {
  const definitions = charter.httpOracles ?? [];
  const names = definitions.map((definition) => definition.name);
  if (new Set(names).size !== names.length) return { code: "duplicate-name" };
  for (const definition of definitions) {
    if (registeredNames.has(definition.name)) return { code: "registered-name-conflict", name: definition.name };
    if (restrictOrigins && !isAllowedMcpApiUrl(definition.url, apiOrigins)) {
      return { code: "origin-disallowed", name: definition.name };
    }
    const scenarios = [{ name: "main", actions: charter.actions, oracles: charter.oracles ?? [] },
      ...(charter.negativeCases ?? []).map((item) => ({ name: item.caseId, actions: item.actions, oracles: item.oracles }))];
    for (const scenario of scenarios.filter((item) => item.oracles.includes(definition.name))) {
      let hasCurrentId = false;
      for (const binding of Object.values(definition.query)) {
        const stepIndex = Number(binding.stepId.slice(5)) - 1;
        const action = scenario.actions[stepIndex];
        if (action?.kind !== "captureResponse" || !Object.hasOwn(action.response.fields, binding.field)) {
          return { code: "binding-invalid", name: definition.name, scenario: scenario.name };
        }
        hasCurrentId ||= ["id", "identifier"].includes(action.response.fields[binding.field]?.type ?? "");
      }
      if (!hasCurrentId) return { code: "current-id-missing", name: definition.name, scenario: scenario.name };
    }
  }
  return undefined;
}

export function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "[::1]"].includes(hostname) || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function isAllowedMcpWebUrl(value: string, configuredBaseUrl?: string): boolean {
  const parsed = new URL(value);
  return isLoopbackHost(parsed.hostname) || Boolean(configuredBaseUrl && parsed.origin === new URL(configuredBaseUrl).origin);
}

export function isAllowedMcpApiUrl(value: string, apiOrigins: readonly string[] = []): boolean {
  const parsed = new URL(value);
  return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password
    && (isLoopbackHost(parsed.hostname) || apiOrigins.includes(parsed.origin));
}
