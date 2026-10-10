import { describe, expect, it } from "vitest";
import { ProjectMapSchema, ProofkitConfigSchema, WorkflowInventorySchema } from "@proofkit/contracts";
import { auditWorkflowCandidates } from "./workflow-candidate-audit.js";

const config = ProofkitConfigSchema.parse({ charters: [{
  id: "resume", path: "charters/resume.yml", aliases: ["resume flow"], level: "core", surfaces: ["web"],
  routeTargets: [{ kind: "web", path: "/resume", source: "src/router.ts" }],
}] });
const inventory = WorkflowInventorySchema.parse({
  schemaVersion: 1, source: { headSha: "a".repeat(40), worktreeSha256: "b".repeat(64) },
  workflows: [{ id: "resume-flow", title: "Resume", sourcePaths: ["src/router.ts"],
    checks: [{ charterId: "resume", surfaces: ["web"] }], surfaces: ["web"] }],
  exclusions: [{ id: "metrics", reason: "No isolated metrics server", sourcePaths: ["src/metrics.ts"] }],
});
const project = ProjectMapSchema.parse({
  root: "/project", detected: { web: true, electron: false, backend: true },
  inventory: {
    routeHints: [
      { kind: "web", path: "/resume", source: "src/router.ts", line: 1 },
      { kind: "web", path: "/hidden", source: "src/router.ts", line: 2 },
      { kind: "api", method: "GET", path: "/metrics", source: "src/metrics.ts", line: 1 },
      { kind: "web", path: "/new", source: "src/new.ts", line: 1 },
    ],
    entryPoints: [
      { kind: "web", path: "src/router.ts", reason: "router" },
      { kind: "backend", path: "src/metrics.ts", reason: "gateway" },
      { kind: "electron", path: "src/main.ts", reason: "main process" },
      { kind: "test", path: "src/router.test.ts", reason: "test" },
    ],
  }, generatedAt: new Date().toISOString(),
});

describe("workflow source candidate review", () => {
  it("separates linked routes, unlinked routes, exclusions and unclaimed entry points", () => {
    const review = auditWorkflowCandidates(project, inventory, config);
    expect(review).toMatchObject({ status: "scanned", routeCandidates: 4, entryCandidates: 3,
      sourceOwned: 3, routeLinked: 1, excluded: 2, unclaimed: 2, unlinkedRoutes: 1, overlappingExclusions: 0 });
    expect(review.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "src/router.ts", path: "/hidden", reason: "unlinked-route" }),
      expect.objectContaining({ source: "src/new.ts", path: "/new", reason: "unclaimed-source" }),
      expect.objectContaining({ source: "src/main.ts", kind: "entry-point", reason: "unclaimed-source" }),
    ]));
    expect(JSON.stringify(review)).not.toContain("router.test.ts");
  });

  it("keeps overlapping exclusions and incomplete static discovery visible", () => {
    const overlapping = WorkflowInventorySchema.parse({ ...inventory, exclusions: [{ id: "router-exclusion", reason: "Needs review", sourcePaths: ["src/router.ts"] }] });
    const partial = ProjectMapSchema.parse({ ...project, inventory: { ...project.inventory, truncated: true,
      routeDiagnostics: { total: 1, items: [{ extractor: "gin", source: "src/gateway.go", line: 3, reason: "dynamic-path" }], omitted: 0 },
      routeHints: [...project.inventory.routeHints, { kind: "web", path: "/invalid", source: "../outside.ts", line: 1 }],
    } });
    const review = auditWorkflowCandidates(partial, overlapping, config);
    expect(review).toMatchObject({ status: "partial", overlappingExclusions: 3, skippedCandidates: 1, unresolvedRouteDeclarations: 0 });
    expect(review.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ source: "src/router.ts", reason: "overlapping-exclusion" })]));
    expect(review.limitations).toEqual(expect.arrayContaining([expect.stringContaining("truncated"), expect.stringContaining("could not be resolved")]));
  });

  it("uses source-directory boundaries and reports focused scans and unresolved route targets", () => {
    const scoped = WorkflowInventorySchema.parse({ ...inventory, workflows: [{ ...inventory.workflows[0], sourcePaths: ["src"] }] });
    const withMissingTarget = ProofkitConfigSchema.parse({ charters: [{ ...config.charters[0],
      routeTargets: [{ kind: "web", path: "/missing", source: "src/router.ts" }],
    }] });
    const focused = ProjectMapSchema.parse({ ...project, inventory: { ...project.inventory, retentionFocus: "resume" } });
    const review = auditWorkflowCandidates(focused, scoped, withMissingTarget);
    expect(review).toMatchObject({ status: "partial", unresolvedRouteDeclarations: 1, unclaimed: 0, unlinkedRoutes: 3 });
    expect(review.limitations).toEqual(expect.arrayContaining([
      expect.stringContaining("focused"), expect.stringContaining("did not resolve uniquely"),
    ]));
  });
});
