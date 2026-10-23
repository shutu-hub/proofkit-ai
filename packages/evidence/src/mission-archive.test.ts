import { watch } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MissionResultSchema, TestCharterSchema, type EvidenceRef } from "@proofkit/contracts";
import { EvidenceStore } from "./index.js";
import { exportMissionArchive, verifyMissionArchive } from "./mission-archive.js";
import { buildRunManifest } from "./manifest.js";

const roots: string[] = [];
const now = "2026-10-21T00:00:00.000Z";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-mission-archive-")); roots.push(root);
  const workspace = join(root, "source"); await mkdir(workspace);
  const store = new EvidenceStore(join(workspace, ".proofkit/runs")); const refs: EvidenceRef[] = [];
  for (const runId of ["run-main", "session-recording"]) {
    await store.startRun({ runId, startedAt: now, endedAt: now, status: "completed", verdict: "inconclusive", projectRoot: root, workspaceRoot: workspace,
      charter: TestCharterSchema.parse({ intent: "Archive saved evidence", actions: [], assertions: [] }), steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    await store.writeText(runId, "facts.txt", "ORIGINAL_SELECTED_FACTS");
    await writeFile(join(workspace, ".proofkit/runs", runId, "report.html"), '<a href="artifacts/facts.txt">Facts</a>');
    const manifest = await store.writeManifest(runId);
    for (const name of ["run.json", "manifest.json"]) {
      const path = join(workspace, ".proofkit/runs", runId, name); refs.push({ evidenceId: runId + ":" + name, kind: "snapshot", path, sha256: hash(await readFile(path)), capturedAt: now, description: "Saved source" });
    }
    expect(manifest.sha256).toBe(refs.at(-1)!.sha256);
  }
  const missionId = "mission-archive"; const snapshotRoot = join(workspace, ".proofkit/missions", missionId); await mkdir(snapshotRoot, { recursive: true });
  const summary = MissionResultSchema.parse({ schemaVersion: "1", missionId, projectRoot: root, workspaceRoot: workspace, intent: "Review original business evidence",
    status: "completed", running: false, verdict: "inconclusive", testVerdict: "inconclusive", level: "core", revision: 1, updatedAt: now, generatedAt: now,
    scope: { surfaces: ["web"], charterCount: 1, uncoveredCharterIds: [] }, tasks: { total: 1, settled: 1, failed: 0, blocked: 0, skipped: 0 }, expectedRuns: 1, observedRuns: 1,
    runs: [{ title: "Original operation", surface: "web", runKind: "primary", runId: "run-main", verdict: "inconclusive", evidence: refs, omittedEvidence: 0 }],
    omittedRunResults: 0, findings: [], omittedFindings: 0, confirmedProductFindings: 0, repairSuggestions: [], omittedRepairSuggestions: 0 });
  const saveSummary = () => writeFile(join(snapshotRoot, "summary.json"), JSON.stringify(summary, null, 2) + "\n"); await saveSummary();
  await writeFile(join(snapshotRoot, "report.html"), '<a href="../../runs/run-main/report.html">Run</a><a href="../../runs/session-recording/report.html">Session</a>');
  await mkdir(join(workspace, ".proofkit/sessions")); await writeFile(join(workspace, ".proofkit/sessions/private-state.json"), "NEVER_EXPORT_AUTH_STATE");
  await writeFile(join(workspace, ".proofkit/config.yaml"), "NEVER_EXPORT_CONFIG");
  const destination = join(root, "exported"); const options = { workspaceRoot: workspace, missionId, destination };
  return { root, workspace, store, summary, refs, snapshotRoot, saveSummary, destination, options };
}
describe("offline Mission evidence archives", () => {
  it("anchors an existing manifest to original event hashes and tolerates metadata-only response notices", async () => {
    const state = await fixture(); const prefix = join(state.workspace, ".proofkit/runs/run-main"); const bytes = await readFile(join(prefix, "artifacts/facts.txt"));
    const body = JSON.parse(await readFile(join(prefix, "run.json"), "utf8")); body.artifacts = ["run-main/artifacts/facts.txt"];
    const events = [{ runId: "run-main", timestamp: now, type: "artifact.created", payload: { path: body.artifacts[0], bytes: bytes.length, sha256: hash(bytes) } },
      { runId: "run-main", timestamp: now, type: "artifact.created", payload: { path: body.artifacts[0], kind: "response-observation" } }];
    const log = events.map((event) => JSON.stringify(event)).join("\n") + "\n"; body.eventLog = { status: "sealed", bytes: Buffer.byteLength(log), sha256: hash(log) };
    await writeFile(join(prefix, "events.jsonl"), log); await writeFile(join(prefix, "run.json"), JSON.stringify(body)); await state.store.writeManifest("run-main");
    state.summary.runs[0]!.evidence = state.summary.runs[0]!.evidence.filter((ref) => !ref.path.endsWith("run-main" + (process.platform === "win32" ? "\\" : "/") + "manifest.json"));
    for (const ref of state.summary.runs[0]!.evidence.filter((ref) => ref.path.includes("run-main"))) ref.sha256 = hash(await readFile(ref.path));
    const report = join(prefix, "report.html"); state.summary.runs[0]!.evidence.push({ evidenceId: "report-anchor", kind: "report", path: report, sha256: hash(await readFile(report)), capturedAt: now, description: "original report" });
    await state.saveSummary(); const receipt = await exportMissionArchive(state.options);
    const archive = JSON.parse(await readFile(join(state.destination, "archive.json"), "utf8")); expect(archive.runs.find((run: { runId: string }) => run.runId === "run-main").snapshotAnchor).toBeDefined();
    expect((await verifyMissionArchive(state.destination, receipt.archiveSha256)).status).toBe("intact");
    await writeFile(join(prefix, "artifacts/facts.txt"), Buffer.alloc(bytes.length, 88)); await state.store.writeManifest("run-main");
    await expect(exportMissionArchive({ ...state.options, destination: join(state.root, "resealed") })).rejects.toThrow("artifact changed");
  });
  it("does not trust an unanchored freshly rebuilt Run manifest", async () => {
    const state = await fixture(); state.summary.runs[0]!.evidence = state.summary.runs[0]!.evidence.filter((ref) => !ref.path.endsWith("run-main" + (process.platform === "win32" ? "\\" : "/") + "manifest.json"));
    await state.saveSummary(); await writeFile(join(state.workspace, ".proofkit/runs/run-main/artifacts/facts.txt"), "REPLACED"); await state.store.writeManifest("run-main");
    await expect(exportMissionArchive(state.options)).rejects.toThrow("original snapshot anchor");
  });
  it("keeps declared coverage, partial network and omitted context explicit and rejects self-rewritten scope", async () => {
    const state = await fixture();
    state.summary.planning = { source: "submitted", confidence: 1, assumptions: [], missingInputs: [], evidenceGaps: [],
      coverage: { requested: "declared", source: "explicit", reason: "one saved scenario", inventory: "bounded", workflowCoverage: "unmeasured", gaps: ["project-workflow-coverage"] } };
    state.summary.sessionContext = { sessionId: "11111111-1111-4111-8111-111111111111", capturedAt: now, runs: [], omittedRuns: 13 };
    await state.saveSummary(); const receipt = await exportMissionArchive(state.options);
    expect(receipt.savedScope.acceptance).toBe("declared"); expect(receipt.savedScope.omittedContextRuns).toBe(13);
    expect((await verifyMissionArchive(state.destination, receipt.archiveSha256)).savedScope).toEqual(receipt.savedScope);
    const descriptor = JSON.parse(await readFile(join(state.destination, "archive.json"), "utf8")); descriptor.savedScope.acceptance = "project";
    await writeFile(join(state.destination, "archive.json"), JSON.stringify(descriptor)); expect((await verifyMissionArchive(state.destination)).status).toBe("unverified");
  });
  it.each(["running", "draft"])("does not accept a %s Mission as a terminal archive even if the running flag is false", async (status) => {
    const state = await fixture(); const receipt = await exportMissionArchive(state.options);
    const descriptorPath = join(state.destination, "archive.json"); const archive = JSON.parse(await readFile(descriptorPath, "utf8"));
    const summaryPath = ".proofkit/missions/mission-archive/summary.json"; const summary = JSON.parse(await readFile(join(state.destination, summaryPath), "utf8"));
    summary.status = status; summary.running = false; const bytes = JSON.stringify(summary); await writeFile(join(state.destination, summaryPath), bytes);
    const file = archive.files.find((file: { path: string }) => file.path === summaryPath); file.sha256 = hash(bytes); file.bytes = Buffer.byteLength(bytes);
    archive.source.summarySha256 = hash(bytes); await writeFile(descriptorPath, JSON.stringify(archive));
    expect((await verifyMissionArchive(state.destination, receipt.archiveSha256)).status).toBe("changed");
    expect((await verifyMissionArchive(state.destination)).status).toBe("unverified");
  });
  it.each(["intact", "artifact", "log", "summary", "report", "unhashed", "execution"])("verifies original event-sealed context without inventing a manifest: %s", async (kind) => {
    const state = await fixture(); const prefix = join(state.workspace, ".proofkit/runs/session-recording");
    const fact = await readFile(join(prefix, "artifacts/facts.txt")); const summaryPath = join(prefix, "run.json");
    const body = JSON.parse(await readFile(summaryPath, "utf8"));
    body.artifacts = ["session-recording/artifacts/facts.txt"];
    const event = { runId: "session-recording", timestamp: now, type: "artifact.created", payload: { path: "session-recording/artifacts/facts.txt", bytes: fact.length,
      ...(kind === "unhashed" ? {} : { sha256: hash(fact) }) } };
    const log = JSON.stringify(event) + "\n"; await writeFile(join(prefix, "events.jsonl"), log);
    body.eventLog = { status: "sealed", bytes: Buffer.byteLength(log), sha256: hash(log) }; await writeFile(summaryPath, JSON.stringify(body));
    await rm(join(prefix, "manifest.json"));
    state.summary.runs[0]!.evidence = state.summary.runs[0]!.evidence.filter((ref) => !ref.path.includes("session-recording"));
    for (const name of ["run.json", "report.html", "events.jsonl"]) {
      const path = join(prefix, name); state.summary.runs[0]!.evidence.push({ evidenceId: "context:" + name, kind: "snapshot", path, sha256: hash(await readFile(path)), capturedAt: now, description: "original context anchor" });
    }
    if (kind === "execution") state.summary.runs[0]!.runId = "session-recording";
    await state.saveSummary();
    if (kind === "artifact") await writeFile(join(prefix, "artifacts/facts.txt"), "CHANGED");
    if (kind === "log") await writeFile(join(prefix, "events.jsonl"), "CHANGED");
    if (kind === "summary") await writeFile(summaryPath, JSON.stringify({ ...body, findings: ["CHANGED"] }));
    if (kind === "report") await writeFile(join(prefix, "report.html"), "CHANGED");
    if (kind !== "intact") await expect(exportMissionArchive(state.options)).rejects.toThrow();
    else {
      const receipt = await exportMissionArchive(state.options); const archive = JSON.parse(await readFile(join(state.destination, "archive.json"), "utf8"));
      expect(archive.runs.filter((run: { seal: string }) => run.seal === "event-log")).toHaveLength(1);
      expect((await verifyMissionArchive(state.destination, receipt.archiveSha256)).status).toBe("intact");
      await writeFile(join(state.destination, ".proofkit/runs/session-recording/artifacts/facts.txt"), "CHANGED");
      expect((await verifyMissionArchive(state.destination, receipt.archiveSha256)).status).toBe("changed");
    }
    await expect(lstat(join(prefix, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["running", "foreign", "wrong-id"])("rejects a newly sealed %s Run rather than archiving active or foreign facts", async (kind) => {
    const state = await fixture(); const source = join(state.workspace, ".proofkit/runs/run-main/run.json");
    const run = JSON.parse(await readFile(source, "utf8"));
    if (kind === "running") run.status = "running";
    if (kind === "foreign") run.workspaceRoot = state.root;
    if (kind === "wrong-id") run.runId = "other-run";
    await writeFile(source, JSON.stringify(run));
    const seal = await buildRunManifest(join(state.workspace, ".proofkit/runs"), "run-main");
    await writeFile(join(state.workspace, ".proofkit/runs/run-main/manifest.json"), JSON.stringify(seal));
    for (const ref of state.summary.runs[0]!.evidence.filter((ref) => ref.path.includes("run-main"))) ref.sha256 = hash(await readFile(ref.path));
    await state.saveSummary(); await expect(exportMissionArchive(state.options)).rejects.toThrow("Run snapshot is active or belongs to another workspace");
  });
  it("uses retained POSIX provenance without requiring that original path to exist on this host", async () => {
    const state = await fixture(); const receipt = await exportMissionArchive(state.options); const archivePath = join(state.destination, "archive.json");
    const archive = JSON.parse(await readFile(archivePath, "utf8")); const summaryPath = ".proofkit/missions/mission-archive/summary.json";
    const summary = JSON.parse(await readFile(join(state.destination, summaryPath), "utf8")); const rewritten = new Map<string, string>();
    const update = async (relativePath: string, value: unknown) => {
      const bytes = JSON.stringify(value); await writeFile(join(state.destination, relativePath), bytes);
      const row = archive.files.find((file: { path: string }) => file.path === relativePath); row.bytes = Buffer.byteLength(bytes); row.sha256 = hash(bytes); rewritten.set(relativePath, row.sha256);
    };
    for (const run of archive.runs) {
      const prefix = ".proofkit/runs/" + run.runId; const body = JSON.parse(await readFile(join(state.destination, prefix, "run.json"), "utf8"));
      body.workspaceRoot = "/frozen/source"; await update(prefix + "/run.json", body);
      const manifest = JSON.parse(await readFile(join(state.destination, prefix, "manifest.json"), "utf8"));
      const row = manifest.files.find((file: { path: string }) => file.path === run.runId + "/run.json");
      row.sha256 = rewritten.get(prefix + "/run.json"); row.bytes = archive.files.find((file: { path: string }) => file.path === prefix + "/run.json").bytes;
      await update(prefix + "/manifest.json", manifest); run.manifestSha256 = rewritten.get(prefix + "/manifest.json");
    }
    const oldPrefix = state.workspace.replaceAll("\\", "/"); summary.workspaceRoot = "/frozen/source";
    for (const ref of summary.runs[0].evidence) {
      const relativePath = ref.path.replaceAll("\\", "/").slice(oldPrefix.length + 1); ref.path = "/frozen/source/" + relativePath; ref.sha256 = rewritten.get(relativePath);
    }
    await update(summaryPath, summary); archive.source.summarySha256 = rewritten.get(summaryPath);
    await writeFile(archivePath, JSON.stringify(archive));
    expect((await verifyMissionArchive(state.destination, receipt.archiveSha256)).status).toBe("changed");
    expect((await verifyMissionArchive(state.destination)).status).toBe("intact");
  });
  it("preserves original bytes and both Run seals after relocation without the source or private state", async () => {
    const state = await fixture(); const originalSummary = await readFile(join(state.snapshotRoot, "summary.json"));
    const receipt = await exportMissionArchive({ ...state.options, expectedSummarySha256: hash(originalSummary) });
    expect(receipt.testVerdict).toBe("not-asserted"); expect(receipt.savedTestVerdict).toBe("inconclusive"); expect(receipt.runs).toBe(2);
    expect(await readFile(join(state.destination, ".proofkit/missions", state.summary.missionId, "summary.json"))).toEqual(originalSummary);
    await expect(readFile(join(state.destination, ".proofkit/config.yaml"))).rejects.toThrow();
    await expect(readFile(join(state.destination, ".proofkit/sessions/private-state.json"))).rejects.toThrow();
    const moved = join(state.root, "moved elsewhere"); await rename(state.destination, moved); await rm(state.workspace, { recursive: true });
    const checked = await verifyMissionArchive(moved, receipt.archiveSha256); expect(checked.status).toBe("intact"); expect(checked.anchor).toBe("pinned");
    expect(checked.testVerdict).toBe("not-asserted"); expect(checked.savedTestVerdict).toBe("inconclusive");
    expect((await verifyMissionArchive(moved)).anchor).toBe("self-described");
  });
  it.each(["changed", "missing", "extra"])("detects %s files without resealing the archive", async (kind) => {
    const state = await fixture(); const receipt = await exportMissionArchive(state.options);
    const artifact = join(state.destination, ".proofkit/runs/run-main/artifacts/facts.txt");
    if (kind === "changed") await writeFile(artifact, "ALTERED"); else if (kind === "missing") await rm(artifact); else await writeFile(join(state.destination, "extra.txt"), "EXTRA");
    const checked = await verifyMissionArchive(state.destination, receipt.archiveSha256); expect(checked.status).toBe(kind === "missing" ? "missing" : "changed");
    expect(hash(await readFile(join(state.destination, "archive.json")))).toBe(receipt.archiveSha256);
  });
  it("requires the separately retained archive pin and checks saved-verdict semantics even without it", async () => {
    const state = await fixture(); const receipt = await exportMissionArchive(state.options);
    const archive = JSON.parse(await readFile(join(state.destination, "archive.json"), "utf8")); archive.savedTestVerdict = "passed";
    await writeFile(join(state.destination, "archive.json"), JSON.stringify(archive));
    expect((await verifyMissionArchive(state.destination, receipt.archiveSha256)).status).toBe("changed");
    expect((await verifyMissionArchive(state.destination)).status).toBe("unverified");
  });
  it("rejects a descriptor that silently drops a referenced Run", async () => {
    const state = await fixture(); await exportMissionArchive(state.options);
    const archive = JSON.parse(await readFile(join(state.destination, "archive.json"), "utf8")); archive.runs = archive.runs.filter((run: { runId: string }) => run.runId !== "session-recording");
    archive.files = archive.files.filter((file: { path: string }) => !file.path.startsWith(".proofkit/runs/session-recording/"));
    await writeFile(join(state.destination, "archive.json"), JSON.stringify(archive)); await rm(join(state.destination, ".proofkit/runs/session-recording"), { recursive: true });
    expect((await verifyMissionArchive(state.destination)).status).toBe("unverified");
  });
  it.each(["active", "foreign", "omitted", "unhashed", "conflict", "traversal", "wrong-digest"])("refuses %s source snapshots before publishing output", async (kind) => {
    const state = await fixture();
    if (kind === "active") state.summary.running = true;
    if (kind === "foreign") state.summary.workspaceRoot = state.root;
    if (kind === "omitted") state.summary.omittedRunResults = 1;
    if (kind === "unhashed") delete state.summary.runs[0]!.evidence[0]!.sha256;
    if (kind === "conflict") state.summary.runs[0]!.evidence.push({ ...state.summary.runs[0]!.evidence[0]!, sha256: "a".repeat(64) });
    if (kind === "traversal") state.summary.runs[0]!.evidence[0]!.path = "../private.txt";
    if (kind === "wrong-digest") state.summary.runs[0]!.evidence[0]!.sha256 = "a".repeat(64);
    await state.saveSummary(); await expect(exportMissionArchive(state.options)).rejects.toThrow();
    await expect(readFile(join(state.destination, "archive.json"))).rejects.toThrow();
  });
  it("rejects changed source artifacts and mismatched original summary pins", async () => {
    const state = await fixture(); await expect(exportMissionArchive({ ...state.options, expectedSummarySha256: "a".repeat(64) })).rejects.toThrow("original digest");
    await writeFile(join(state.workspace, ".proofkit/runs/run-main/artifacts/facts.txt"), "CHANGED");
    await expect(exportMissionArchive(state.options)).rejects.toThrow("Run evidence is incomplete or changed");
    await expect(readFile(join(state.destination, "archive.json"))).rejects.toThrow();
  });
  it("refuses existing destinations, in-workspace output and redirected sources or parents", async () => {
    const state = await fixture(); await mkdir(state.destination); await writeFile(join(state.destination, "sentinel"), "OWNED_BY_USER");
    await expect(exportMissionArchive(state.options)).rejects.toThrow("already exists"); expect(await readFile(join(state.destination, "sentinel"), "utf8")).toBe("OWNED_BY_USER");
    await expect(exportMissionArchive({ ...state.options, destination: join(state.workspace, "nested") })).rejects.toThrow("separate");
    const realParent = join(state.root, "real-parent"); await mkdir(realParent); const redirected = join(state.root, "redirected"); await symlink(realParent, redirected, process.platform === "win32" ? "junction" : "dir");
    await expect(exportMissionArchive({ ...state.options, destination: join(redirected, "output") })).rejects.toThrow("redirected");
    const artifacts = join(state.workspace, ".proofkit/runs/run-main/artifacts"); const saved = join(state.root, "external-artifacts"); await rename(artifacts, saved); await symlink(saved, artifacts, process.platform === "win32" ? "junction" : "dir");
    await expect(exportMissionArchive({ ...state.options, destination: join(state.root, "other") })).rejects.toThrow();
  });
  it("stops an interrupted copy, removes only its new output and leaves original seals unchanged", async () => {
    const state = await fixture(); const original = await readFile(join(state.workspace, ".proofkit/runs/run-main/manifest.json")); const controller = new AbortController();
    const watcher = watch(state.root, (_event, filename) => { if (filename?.toString() === "exported") controller.abort(new Error("cancel during copy")); });
    try { await expect(exportMissionArchive({ ...state.options, signal: controller.signal })).rejects.toThrow("cancel during copy"); }
    finally { watcher.close(); }
    expect(await readFile(join(state.workspace, ".proofkit/runs/run-main/manifest.json"))).toEqual(original);
    await expect(readFile(join(state.destination, "archive.json"))).rejects.toThrow();
    await expect(lstat(state.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["path", "bytes", "total", "runs"])("refuses a descriptor exceeding its %s boundary", async (kind) => {
    const state = await fixture(); await exportMissionArchive(state.options); const archive = JSON.parse(await readFile(join(state.destination, "archive.json"), "utf8"));
    if (kind === "path") archive.files[0].path = "../escape";
    if (kind === "bytes") archive.files[0].bytes = 64 * 1024 * 1024 + 1;
    if (kind === "total") for (const file of archive.files) file.bytes = 64 * 1024 * 1024;
    if (kind === "runs") archive.runs = Array.from({ length: 129 }, (_, index) => ({ runId: "run-" + index, manifestSha256: "a".repeat(64) }));
    await writeFile(join(state.destination, "archive.json"), JSON.stringify(archive)); expect((await verifyMissionArchive(state.destination)).status).toBe("unverified");
  });
});
