import type { ProjectMap, RouteCoverageTarget } from "@proofkit/contracts";

type RouteHint = ProjectMap["inventory"]["routeHints"][number];
export type RouteDeclaration = { charterId: string; routeTargets?: RouteCoverageTarget[] };
export type UnresolvedRouteTarget = RouteCoverageTarget & { charterId: string; reason: "absent" | "ambiguous" };

/** Reconcile static declarations only. Runtime coverage is owned by the Mission verifier. */
export function reconcileRouteDeclarations(hints: RouteHint[], declarations: RouteDeclaration[]): {
  routes: Array<{ candidate: RouteHint; charterIds: string[]; runtimeSourceAmbiguous: boolean }>;
  declaredTargets: number;
  unresolvedTargets: UnresolvedRouteTarget[];
} {
  const bySource = new Map<string, RouteHint>();
  for (const route of hints) bySource.set(routeKey(route), route);
  const routes = [...bySource.values()];
  const byRuntimePath = new Map<string, RouteHint[]>();
  for (const route of routes) {
    const key = runtimeKey(route);
    const matches = byRuntimePath.get(key) ?? [];
    matches.push(route);
    byRuntimePath.set(key, matches);
  }
  const mapped = new Map<string, Set<string>>();
  const unresolvedTargets: UnresolvedRouteTarget[] = [];
  let declaredTargets = 0;
  for (const { charterId, routeTargets } of declarations) {
    for (const target of routeTargets ?? []) {
      declaredTargets++;
      const candidates = target.kind === "web"
        ? routes.filter((route) => route.kind === "web" && route.path === target.path)
        : byRuntimePath.get(runtimeKey(target)) ?? [];
      const matches = candidates.filter((route) => !target.source || route.source === target.source);
      if (matches.length !== 1) {
        unresolvedTargets.push({ ...target, charterId, reason: matches.length === 0 ? "absent" : "ambiguous" });
        continue;
      }
      const key = routeKey(matches[0]!);
      const charterIds = mapped.get(key) ?? new Set<string>();
      charterIds.add(charterId);
      mapped.set(key, charterIds);
    }
  }
  return {
    declaredTargets,
    unresolvedTargets,
    routes: routes.map((candidate) => ({
      candidate,
      charterIds: [...(mapped.get(routeKey(candidate)) ?? [])],
      runtimeSourceAmbiguous: (byRuntimePath.get(runtimeKey(candidate))?.length ?? 0) > 1,
    })),
  };
}

function runtimeKey(route: { kind: string; path: string; method?: string }): string {
  return `${route.kind}\0${route.path}\0${route.method ?? ""}`;
}
function routeKey(route: RouteHint): string {
  return `${runtimeKey(route)}\0${route.source}`;
}
