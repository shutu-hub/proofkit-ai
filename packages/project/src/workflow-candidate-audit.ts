import { WorkflowCandidateAuditSchema, workflowChecks, type ProofkitConfig, type ProjectMap, type WorkflowCandidateAudit, type WorkflowInventory } from "@proofkit/contracts";
import { reconcileRouteDeclarations } from "./route-map.js";

/** Cross-check bounded source candidates against declared workflow ownership. This is review guidance, not a completeness proof. */
export function auditWorkflowCandidates(project: ProjectMap, inventory: WorkflowInventory, config: ProofkitConfig): WorkflowCandidateAudit {
  const included = new Set(inventory.workflows.flatMap((workflow) => workflowChecks(workflow).map((check) => check.charterId)));
  const routes = reconcileRouteDeclarations(project.inventory.routeHints, config.charters
    .filter((entry) => included.has(entry.id))
    .map((entry) => ({ charterId: entry.id, routeTargets: entry.routeTargets })));
  const entries = project.inventory.entryPoints.filter((entry) => entry.kind === "web" || entry.kind === "electron" || entry.kind === "backend");
  const gaps: WorkflowCandidateAudit["gaps"] = [];
  let sourceOwned = 0;
  let routeLinked = 0;
  let excluded = 0;
  let unclaimed = 0;
  let unlinkedRoutes = 0;
  let overlappingExclusions = 0;
  let skippedCandidates = 0;
  const record = (candidate: WorkflowCandidateAudit["gaps"][number], linkedCharters?: string[]) => {
    if (!safeSourcePath(candidate.source)) {
      skippedCandidates++;
      return;
    }
    const owners = inventory.workflows.filter((workflow) => workflow.sourcePaths.some((path) => ownsSource(path, candidate.source)));
    const excludedBy = inventory.exclusions.filter((item) => item.sourcePaths.some((path) => ownsSource(path, candidate.source)));
    if (owners.length) sourceOwned++;
    if (owners.length && excludedBy.length) {
      overlappingExclusions++;
      gaps.push({ ...candidate, reason: "overlapping-exclusion" });
      return;
    }
    if (!owners.length && excludedBy.length) {
      excluded++;
      return;
    }
    if (!owners.length) {
      unclaimed++;
      gaps.push({ ...candidate, reason: "unclaimed-source" });
      return;
    }
    if (linkedCharters) {
      const expected = new Set(owners.flatMap((workflow) => workflowChecks(workflow).map((check) => check.charterId)));
      if (!linkedCharters.some((charterId) => expected.has(charterId))) {
        unlinkedRoutes++;
        gaps.push({ ...candidate, reason: "unlinked-route" });
      } else {
        routeLinked++;
      }
    }
  };
  for (const route of routes.routes) record({
    kind: route.candidate.kind === "api" ? "api-route" : "web-route",
    source: route.candidate.source, path: route.candidate.path,
    ...(route.candidate.method ? { method: route.candidate.method } : {}),
    reason: "unclaimed-source",
  }, route.charterIds);
  for (const entry of entries) record({ kind: "entry-point", source: entry.path, reason: "unclaimed-source" });
  gaps.sort((left, right) => left.source.localeCompare(right.source) || (left.path ?? "").localeCompare(right.path ?? "") || left.reason.localeCompare(right.reason));
  const unresolvedRouteDeclarations = routes.unresolvedTargets.length;
  const partial = project.inventory.truncated || Boolean(project.inventory.retentionFocus)
    || Boolean(project.inventory.routeDiagnostics?.total) || skippedCandidates > 0;
  const limitations = [
    "Static entry points and route hints can omit dynamically registered paths and business transitions.",
    ...(project.inventory.truncated ? ["The bounded project scan was truncated."] : []),
    ...(project.inventory.retentionFocus ? ["The project scan was focused on a source subset."] : []),
    ...(project.inventory.routeDiagnostics?.total ? [`${project.inventory.routeDiagnostics.total} route declarations could not be resolved statically.`] : []),
    ...(skippedCandidates ? [`${skippedCandidates} candidates had unusable source paths.`] : []),
    ...(unresolvedRouteDeclarations ? [`${unresolvedRouteDeclarations} Charter route targets did not resolve uniquely to scanned candidates.`] : []),
    ...(routes.routes.length + entries.length === 0 ? ["No source candidates were discovered; this is not proof that the project has no workflows."] : []),
  ];
  return WorkflowCandidateAuditSchema.parse({
    status: partial ? "partial" : "scanned",
    routeCandidates: routes.routes.length,
    entryCandidates: entries.length,
    sourceOwned, routeLinked, excluded, unclaimed, unlinkedRoutes, overlappingExclusions,
    unresolvedRouteDeclarations, skippedCandidates,
    gaps: gaps.slice(0, 20), omittedGaps: Math.max(0, gaps.length - 20), limitations: limitations.slice(0, 5),
  });
}

function ownsSource(owner: string, source: string): boolean {
  return source === owner || source.startsWith(`${owner}/`);
}

function safeSourcePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.includes("\\") && !value.includes(":")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
