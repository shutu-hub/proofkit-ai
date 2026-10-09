import { TestScopeSchema, type CharterCatalogEntry, type ProofkitConfig, type ProjectMap, type SuiteCatalogEntry, type TestScope, type TestScopeInputSchema } from "@proofkit/contracts";
import { requiredCatalogSurfaces, supportsCatalogCharter, supportsCatalogSuite } from "@proofkit/planner";
import { reconcileRouteDeclarations } from "@proofkit/project";
import { z, type BusinessOracle, type CapabilityDefinition, type ProjectIntegration } from "@proofkit/runner";
import { describeInputShape } from "./schema-hints.js";

type Request = z.output<typeof TestScopeInputSchema>;
type Check = TestScope["catalog"]["items"][number]["check"];
export type ScopeContext = {
  project: ProjectMap;
  workspaceRoot: string;
  config: ProofkitConfig;
  integration?: ProjectIntegration;
  capabilities: CapabilityDefinition<any, any>[];
  oracles: BusinessOracle[];
  allowCapabilityWrites: boolean;
  checkCharter(entry: CharterCatalogEntry): Promise<void>;
  checkSuite(entry: SuiteCatalogEntry): Promise<void>;
};

export async function inspectTestScope(context: ScopeContext, request: Request): Promise<TestScope> {
  const { project, config } = context;
  const { level, surface, limit } = request;
  const focus = request.focus?.normalize("NFKC").toLowerCase();
  const matches = (...values: Array<string | undefined>) => !focus || values.some((value) => value?.normalize("NFKC").toLowerCase().includes(focus));
  const eligibleCharters = config.charters.filter((entry) => supportsCatalogCharter(entry, level, surface));
  const eligibleIds = new Set(eligibleCharters.map((entry) => entry.id));
  const charterMatches = (entry: CharterCatalogEntry) => matches(entry.id, entry.path, ...entry.aliases, ...(entry.routeTargets ?? []).flatMap((target) => [target.path, target.source]));
  const selectedCharters = config.charters.filter(charterMatches).sort((left, right) => Number(eligibleIds.has(right.id)) - Number(eligibleIds.has(left.id)) || left.id.localeCompare(right.id));
  const focusedIds = new Set(selectedCharters.map((entry) => entry.id));
  const mapping = reconcileRouteDeclarations(project.inventory.routeHints, eligibleCharters.map((entry) => ({ charterId: entry.id, routeTargets: entry.routeTargets })));
  const routes = mapping.routes.filter(({ candidate, charterIds }) => matches(candidate.path, candidate.source) || charterIds.some((id) => focusedIds.has(id)));
  const unresolved = mapping.unresolvedTargets.filter((target) => matches(target.charterId, target.path, target.source) || focusedIds.has(target.charterId));
  const entries = project.inventory.entryPoints.filter((entry) => matches(entry.path));
  const eligibleSuites = config.suites.filter((entry) => supportsCatalogSuite(entry, level, surface));
  const suiteIds = new Set(eligibleSuites.map((entry) => entry.id));
  const suites = config.suites.filter((entry) => matches(entry.id, ...entry.aliases) || entry.charterIds.some((id) => focusedIds.has(id)))
    .sort((left, right) => Number(suiteIds.has(right.id)) - Number(suiteIds.has(left.id)) || left.id.localeCompare(right.id));
  const check = async (eligible: boolean, validate: () => Promise<void>): Promise<Check> => {
    if (!eligible) return { eligible: false, planReady: false, issues: ["Catalog level or required surface matrix does not match this request"] };
    try {
      await validate();
      return { eligible: true, planReady: true, issues: [] };
    } catch (error) {
      return { eligible: true, planReady: false, issues: [planIssue(error)] };
    }
  };
  const catalogItems: TestScope["catalog"]["items"] = [];
  for (const entry of selectedCharters.slice(0, limit)) {
    catalogItems.push({ id: entry.id, path: entry.path, aliases: entry.aliases.slice(0, 10), omittedAliases: Math.max(0, entry.aliases.length - 10), level: entry.level, surfaces: entry.surfaces,
      check: await check(eligibleIds.has(entry.id), () => context.checkCharter(entry)) });
  }
  const suiteItems: TestScope["suites"]["items"] = [];
  for (const entry of suites.slice(0, limit)) {
    suiteItems.push({ id: entry.id, charterIds: entry.charterIds.slice(0, 50), omittedCharterIds: Math.max(0, entry.charterIds.length - 50),
      check: await check(suiteIds.has(entry.id), () => context.checkSuite(entry)) });
  }
  const capabilityMatches = context.capabilities.filter((item) => matches(item.name, item.description));
  const allOracles = [...context.oracles.map((item) => ({ name: item.name, kind: "registered" as const })), ...config.oracles.map((item) => ({ name: item.name, kind: "configured-http" as const }))];
  const oracleMatches = allOracles.filter((item) => matches(item.name));
  const { entryPoints: _entries, routeHints: _routes, ...inventory } = project.inventory;
  const limitations = [
    "Static route-shaped literals and conventional entry points are candidate hints; no execution coverage or product verdict is calculated",
    "Route scanning does not compose grouped API prefixes or relative child routes, and can include non-router literals",
    "Declarations from eligible catalog entries can be mapped even when their saved plan is invalid; mapping is not proof of a ready or tested workflow",
    "Only returned eligible plans are read and checked; login, endpoints, fixtures, preflight and runtime capability inputs have not been checked",
    "Connector registration code is trusted and may run when the service is created; this inspection does not invoke setup, preflight, operations or business checks",
  ];
  if (inventory.truncated) limitations.push("Project inventory is truncated; counts describe only the scanned candidate slice");
  if (focus) limitations.push("Focus is a literal substring filter; the focused view is not whole-project coverage");
  return TestScopeSchema.parse({
    schemaVersion: 1, testVerdict: "not-asserted", executionChecks: "not-run",
    projectRoot: project.root, workspaceRoot: context.workspaceRoot,
    selection: { ...request, requiredSurfaces: requiredCatalogSurfaces(level, surface) }, inventory,
    entryPoints: { total: project.inventory.entryPoints.length, matched: entries.length, items: entries.slice(0, limit), omitted: Math.max(0, entries.length - limit) },
    routes: {
      total: mapping.routes.length, matched: routes.length, declaredTargets: mapping.declaredTargets,
      mapped: routes.filter((route) => route.charterIds.length > 0).length, unmapped: routes.filter((route) => route.charterIds.length === 0).length,
      items: routes.slice(0, limit).map(({ candidate, charterIds, runtimeSourceAmbiguous }) => ({ ...candidate, charterIds: charterIds.slice(0, 50), omittedCharterIds: Math.max(0, charterIds.length - 50), status: charterIds.length ? "declared" : "unmapped", runtimeSourceAmbiguous })),
      omitted: Math.max(0, routes.length - limit), unresolvedTargets: unresolved.slice(0, limit), omittedUnresolvedTargets: Math.max(0, unresolved.length - limit),
    },
    catalog: { total: config.charters.length, eligible: eligibleCharters.length, matched: selectedCharters.length, items: catalogItems, omitted: Math.max(0, selectedCharters.length - limit) },
    suites: { total: config.suites.length, eligible: eligibleSuites.length, matched: suites.length, items: suiteItems, omitted: Math.max(0, suites.length - limit) },
    ...(context.integration ? { integration: { name: context.integration.name, version: context.integration.version, preflightRegistered: Boolean(context.integration.preflight), setupRegistered: Boolean(context.integration.setup) } } : {}),
    capabilities: { total: context.capabilities.length, matched: capabilityMatches.length, omitted: Math.max(0, capabilityMatches.length - limit), items: capabilityMatches.slice(0, limit).map((item) => ({
      name: item.name, description: item.description.slice(0, 500), sideEffect: item.sideEffect, environments: item.environments,
      environmentAllowed: item.environments.includes(config.policies.environment), operatorWriteOptIn: context.allowCapabilityWrites,
      inputShape: describeInputShape(item.inputSchema),
    })) },
    oracles: { total: allOracles.length, matched: oracleMatches.length, omitted: Math.max(0, oracleMatches.length - limit), items: oracleMatches.slice(0, limit) },
    limitations, next: ["inspect_surface", "run_test"], generatedAt: project.generatedAt,
  });
}

/** Parser messages can include raw Charter values; return locations and categories instead. */
function planIssue(error: unknown): string {
  if (error instanceof z.ZodError) {
    const details = error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "Charter"}: ${issue.code}`);
    return `Invalid test plan schema (${details.join("; ")})`.slice(0, 400);
  }
  if (error instanceof Error && error.name === "YAMLParseError") return "Invalid test plan YAML; inspect the workspace-owned Charter source";
  return error instanceof Error ? error.message.slice(0, 400) : "Workspace test plan could not be validated";
}
