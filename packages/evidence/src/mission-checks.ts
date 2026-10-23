import { MissionCheckOverviewSchema, type Assertion, type EvidenceRef, type MissionCheckOverview, type MissionRunResult, type RunSummary } from "@proofkit/contracts";

type Check = MissionCheckOverview["items"][number];
export type MissionCheckSource = { run: MissionRunResult; summary?: RunSummary; summaryEvidence?: EvidenceRef; reportEvidence?: EvidenceRef; checkEvidence?: EvidenceRef[] };

function assertionKey(assertion: Assertion): string {
  return JSON.stringify([assertion.kind, assertion.kind === "url-matches" ? assertion.pattern : assertion.text]);
}

function describe(assertion: Assertion): string {
  if (assertion.kind === "url-matches") return "URL matches the declared pattern";
  const label = assertion.kind === "text-visible" ? "Expected visible text" : assertion.kind === "text-not-visible" ? "Expected absent text" : "Expected title text";
  return label + ": " + assertion.text;
}

export function projectMissionChecks(sources: MissionCheckSource[], omittedRuns: number, redact: (value: string) => string): MissionCheckOverview {
  const items: Check[] = [];
  const unavailableRuns: MissionCheckOverview["unavailableRuns"] = [];
  let inspectedRuns = 0;
  for (const { run, summary, summaryEvidence, reportEvidence, checkEvidence = [] } of sources) {
    if (!run.runId || !summary || !summaryEvidence) {
      unavailableRuns.push({ runId: run.runId, title: redact(run.title) });
      continue;
    }
    inspectedRuns++;
    const base = { runId: run.runId, title: redact(run.title), runKind: run.runKind, summary: summaryEvidence, report: reportEvidence };
    const support = (paths: string[]) => {
      const requested = [...new Set(paths.map((path) => path.replaceAll("\\", "/")))];
      const evidence: EvidenceRef[] = [];
      for (const target of requested) {
        if (target.split("/").some((part) => part === ".." || part === ".")) continue;
        const found = checkEvidence.find((ref) => {
          const path = ref.path.replaceAll("\\", "/");
          return path === target || (target.startsWith(run.runId + "/") && path.endsWith("/" + target));
        });
        if (found && evidence.length < 3 && !evidence.includes(found)) evidence.push(found);
      }
      return { evidence, unlinkedEvidence: Math.max(0, requested.length - evidence.length) };
    };
    const assertions = new Map<string, typeof summary.assertions>();
    for (const check of summary.assertions) {
      const key = assertionKey(check.assertion);
      assertions.set(key, [...(assertions.get(key) ?? []), check]);
    }
    const expectedCounts = new Map<string, number>();
    for (const assertion of summary.charter.assertions) {
      const key = assertionKey(assertion);
      expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
    }
    const ambiguousAssertions = new Set([...assertions].filter(([key, checks]) => checks.length > (expectedCounts.get(key) ?? 0)).map(([key]) => key));
    for (const assertion of summary.charter.assertions) {
      const key = assertionKey(assertion);
      const check = assertions.get(key)?.shift();
      items.push({ ...base, ...support(check?.evidence ?? []), kind: "surface", expected: redact(describe(assertion)),
        status: ambiguousAssertions.has(key) ? "unverified" : !check ? "not-recorded" : check.passed ? "passed" : "failed",
        observed: ambiguousAssertions.has(key) ? "Recorded results exceed the matching declared expectations." : check ? redact(check.message) : "No result was recorded for this declared check." });
    }
    for (const checks of assertions.values()) for (const check of checks) {
      items.push({ ...base, ...support(check.evidence), kind: "surface", expected: redact(describe(check.assertion)), status: "unverified",
        observed: "Recorded result has no remaining matching declared expectation." });
    }
    const oracles = new Map<string, typeof summary.oracles>();
    for (const check of summary.oracles) oracles.set(check.name, [...(oracles.get(check.name) ?? []), check]);
    const names = new Map<string, number>();
    for (const name of summary.charter.oracles ?? []) names.set(name, (names.get(name) ?? 0) + 1);
    for (const [name, declaredCount] of names) {
      const checks = oracles.get(name) ?? [];
      const check = checks.length === 1 ? checks[0] : undefined;
      const linked = support([...(check?.sourceEvidenceArtifacts ?? []), ...(check?.evidence ?? [])]);
      const sourceLinked = check?.sourceEvidenceArtifacts?.some((path) => linked.evidence.some((ref) => {
        const actual = ref.path.replaceAll("\\", "/");
        return actual === path || actual.endsWith("/" + path);
      }));
      items.push({ ...base, ...linked, kind: check?.verificationKind ?? "unclassified", expected: redact(name),
        status: declaredCount > 1 || checks.length > 1 ? "unverified" : !check ? "not-recorded" : check.passed === null ? "inconclusive" : check.passed ? "passed" : "failed",
        ...(declaredCount === 1 && check?.passed === false && check.verificationKind === "business" && sourceLinked && check.fieldMismatches
          ? { fieldMismatches: check.fieldMismatches.map(redact) } : {}),
        observed: declaredCount > 1 ? "Independent check is declared more than once; results cannot be uniquely assigned." : checks.length > 1 ? "Multiple results were recorded for one declared independent check." : check ? redact(check.message) : "No result was recorded for this declared independent check." });
      oracles.delete(name);
    }
    for (const checks of oracles.values()) for (const check of checks) {
      items.push({ ...base, ...support([...(check.sourceEvidenceArtifacts ?? []), ...check.evidence]), kind: check.verificationKind ?? "unclassified", expected: redact(check.name), status: "unverified",
        observed: "Recorded result has no matching declared independent check." });
    }
  }
  const counts = { passed: 0, failed: 0, inconclusive: 0, "not-recorded": 0, unverified: 0 };
  for (const item of items) counts[item.status]++;
  const priority: Record<Check["status"], number> = { failed: 0, inconclusive: 1, unverified: 2, "not-recorded": 3, passed: 4 };
  items.sort((left, right) => priority[left.status] - priority[right.status]);
  return MissionCheckOverviewSchema.parse({ scope: "saved-run-checks", inspectedRuns, unavailableRuns, omittedRuns, counts,
    items: items.slice(0, 100), omittedChecks: Math.max(0, items.length - 100) });
}
