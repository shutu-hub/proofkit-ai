import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestCharterSchema, type ResponseObservation, type RunSummary } from "@proofkit/contracts";
import { atomicWriteJson, EvidenceStore, sha256 } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("response report diagnostics and redaction", () => {
  it.each(["success", "unexpected", "incomplete"])("redacts runtime response fields and withdraws changed artifacts, mode=%s", async (mode) => {
    const unexpected = mode !== "success";
    const root = await mkdtemp(join(tmpdir(), "proofkit-response-privacy-")); roots.push(root); const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "Inspect declared response facts", actions: [{ kind: "captureResponse", name: "request",
      trigger: { kind: "click", selector: "#submit" }, response: { url: "http://127.0.0.1/requests", method: "POST", fields: {
        tokenValue: { pointer: "/token", type: "string" } }, errorFields: { secretReason: { pointer: "/reason", type: "string" } },
        requestFields: { password: { pointer: "/password", type: "string" } },
        queryFields: { tenant: { pointer: "/tenant", type: "identifier" }, token: { pointer: "/token", type: "string" } } } }], assertions: [] });
    const response: ResponseObservation = { name: "request", association: "action-window" as const, url: "http://127.0.0.1/requests", method: "POST", status: unexpected ? 422 : 201, requestCount: 1 as const,
      windowStartedAt: "2026-10-20T00:00:00.000Z", windowEndedAt: "2026-10-20T00:00:01.000Z", capturedAt: "2026-10-20T00:00:01.000Z",
      bodyBytes: 36, bodySha256: "a".repeat(64), requestBodyBytes: 14, requestBodySha256: "b".repeat(64), requestFields: { password: "PRIVATE_RUNTIME_REQUEST" },
      queryFields: { tenant: "team42", token: "PRIVATE_RUNTIME_QUERY" },
      fields: unexpected ? { secretReason: "PRIVATE_RUNTIME_ERROR" } : { tokenValue: "PRIVATE_RUNTIME_SUCCESS" } };
    const responseError = { ...response, status: mode === "incomplete" ? 201 : 422,
      kind: mode === "incomplete" ? "incomplete-fields" as const : "unexpected-status" as const,
      acceptance: "not-established" as const, expectedStatuses: [200, 201], fieldGaps: mode === "incomplete" ? [{ name: "missing", code: "missing" as const }] : [] };
    const summary: RunSummary = { runId: "privacy-run", startedAt: response.capturedAt, status: "completed", verdict: "inconclusive", charter,
      steps: [{ stepId: "step-001", action: charter.actions[0]!, status: unexpected ? "failed" : "passed", artifacts: [],
        ...(unexpected ? { responseError } : { response }) }], assertions: [], oracles: [], artifacts: [], findings: [] };
    await store.startRun(summary);
    const artifact = await store.writeJson(summary.runId, unexpected ? "step-001-response-error" : "step-001-response", unexpected ? responseError : response);
    summary.steps[0]!.artifacts.push(artifact); summary.artifacts.push(artifact);
    const title = mode === "incomplete" ? "Incomplete response diagnostics" : unexpected ? "Unexpected response diagnostics" : "Captured API facts";
    const report = await readFile(await store.writeReport(summary), "utf8");
    expect(report).toContain(title); expect(report).toContain("Selected query fields"); expect(report).toContain("team42");
    expect(report).toContain("[REDACTED]"); expect(report).not.toContain("PRIVATE_RUNTIME_");
    expect(await readFile(join(root, artifact), "utf8")).not.toContain("PRIVATE_RUNTIME_");
    await writeFile(join(root, artifact), "changed facts");
    const changed = await readFile(await store.writeReport(summary), "utf8");
    expect(changed).not.toContain('<summary>' + title + '</summary>'); expect(changed).toContain("unavailable or changed");
  });
});

describe("EvidenceStore event streaming", () => {
  it("keeps response projection and reader declarations parseable while redacting selected secret facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-declaration-redaction-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "Verify login metadata without recording credentials", level: "quick", actions: [{ kind: "captureResponse", name: "login",
      trigger: { kind: "click", selector: "#login" }, response: { url: "https://api.example.test/login", method: "POST",
        fields: { tokenType: { pointer: "/token_type", type: "string" }, id: { pointer: "/id", type: "identifier" } },
        requestFields: { phoneCategory: { pointer: "/phone_category", type: "string" } } } }], assertions: [],
      httpOracles: [{ name: "current", url: "https://api.example.test/read", query: {
        token: { source: "response", stepId: "step-001", field: "id", matchPointer: "/id" } }, statusPointer: "/status", successValues: ["done"] }] });
    const now = "2026-10-20T00:00:00.000Z";
    const response = { name: "login", association: "action-window" as const, url: "https://api.example.test/login", method: "POST", status: 200,
      requestCount: 1 as const, windowStartedAt: now, windowEndedAt: now, capturedAt: now, bodyBytes: 100, bodySha256: "a".repeat(64),
      fields: { tokenType: "PRIVATE_VALUE", id: "record-1" }, requestFields: { phoneCategory: "PRIVATE_PHONE" } };
    const summary: RunSummary = { runId: "declaration-run", startedAt: now, status: "completed", verdict: "passed", charter,
      steps: [{ stepId: "step-001", action: charter.actions[0]!, status: "passed", response, artifacts: [] }], assertions: [], oracles: [], artifacts: [], findings: [] };
    await store.startRun(summary);
    const saved = await store.loadSummary(summary.runId);
    expect(saved.charter.actions).toEqual(charter.actions);
    expect(saved.charter.httpOracles).toEqual(charter.httpOracles);
    expect(saved.steps[0]?.response?.fields).toEqual({ tokenType: "[REDACTED]", id: "record-1" });
    expect(saved.steps[0]?.response?.requestFields).toEqual({ phoneCategory: "[REDACTED]" });
    const artifact = await store.writeJson(summary.runId, "nested-secrets", { authorization: { fields: { safe: "PRIVATE_HEADER" } }, fields: { token: "PRIVATE_TOKEN" } });
    const bytes = await readFile(join(root, artifact), "utf8");
    expect(bytes).not.toContain("PRIVATE_");
  });
  it("withdraws selected-page inventories and screenshots after their original bytes change", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-page-report-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "Inspect selected review page", level: "quick", actions: [{ kind: "switchPage", title: "Review" }], assertions: [] });
    const snapshot = { capturedAt: "2026-10-19T00:00:00.000Z", title: "Review", metadata: {}, pages: [
      { title: "Portal", url: "http://fixture.local/", active: false, eligibleForSwitch: true },
      { title: "Review", url: "http://fixture.local/__redacted__", active: true, eligibleForSwitch: true }] };
    const summary: RunSummary = { runId: "page-run", startedAt: snapshot.capturedAt, status: "completed", verdict: "inconclusive", charter,
      execution: { adapter: "web" },
      steps: [{ stepId: "step-001", action: charter.actions[0]!, status: "passed", afterSnapshot: snapshot, artifacts: [] }], assertions: [], oracles: [], artifacts: [], findings: [] };
    await store.startRun(summary);
    const source = await store.writeJson(summary.runId, "step-001-after", snapshot);
    const screenshot = await store.writeBuffer(summary.runId, "step-001.png", Buffer.from("synthetic image bytes"));
    summary.steps[0]!.artifacts.push(source, screenshot); summary.artifacts.push(source, screenshot);
    const report = await store.writeReport(summary);
    const intact = await readFile(report, "utf8");
    expect(intact).toContain("Page inventory (2)"); expect(intact).toContain("Selected: Review");
    expect(intact).toContain('<img src="artifacts/step-001.png"');
    expect(intact).toContain("Historical screenshots, other text, iframes, canvas and all video frames may contain sensitive data");
    await writeFile(join(root, source), "changed inventory"); await writeFile(join(root, screenshot), "changed pixels");
    const changed = await readFile(await store.writeReport(summary), "utf8");
    expect(changed).not.toContain("Selected: Review"); expect(changed).toContain("Page inventory unavailable or changed");
    expect(changed).not.toContain('<img src="artifacts/step-001.png"');
  });

  it("displays selected API facts only while their original saved artifact matches the Run summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-response-report-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "Verify current request", level: "quick", actions: [{ kind: "captureResponse", name: "request",
      trigger: { kind: "click", selector: "#submit" }, response: { url: "http://127.0.0.1/requests", method: "POST", fields: {
        id: { pointer: "/id", type: "identifier" } }, requestFields: { quantity: { pointer: "/quantity", type: "number" } } } }], assertions: [] });
    const response = { name: "request", association: "action-window" as const, url: "http://127.0.0.1/requests", method: "POST", status: 201, requestCount: 1 as const,
      windowStartedAt: "2026-10-19T00:00:00.000Z", windowEndedAt: "2026-10-19T00:00:01.000Z", capturedAt: "2026-10-19T00:00:01.000Z",
      bodyBytes: 36, bodySha256: "a".repeat(64), requestBodyBytes: 14, requestBodySha256: "b".repeat(64), requestFields: { quantity: 2 }, fields: { id: "request-1" } };
    const summary: RunSummary = { runId: "response-run", startedAt: "2026-10-19T00:00:00.000Z", status: "completed", verdict: "inconclusive", charter,
      steps: [{ stepId: "step-001", action: charter.actions[0]!, status: "passed", response, artifacts: [] }], assertions: [], oracles: [], artifacts: [], findings: [] };
    await store.startRun(summary);
    const artifact = await store.writeJson(summary.runId, "step-001-response", response);
    summary.steps[0]!.artifacts.push(artifact); summary.artifacts.push(artifact);
    const report = await store.writeReport(summary);
    expect(await readFile(report, "utf8")).toContain("Captured API facts");
    expect(await readFile(report, "utf8")).toContain("request-1");
    summary.steps[0]!.response = { ...response, fields: { id: "forged-id" } };
    expect(await readFile(await store.writeReport(summary), "utf8")).not.toContain("forged-id");
    expect(await readFile(report, "utf8")).toContain("Selected API facts unavailable or changed");
    summary.steps[0]!.response = response;
    await writeFile(join(root, artifact), "changed response facts");
    expect(await readFile(await store.writeReport(summary), "utf8")).not.toContain("Captured API facts");
    expect(await readFile(report, "utf8")).toContain("Selected API facts unavailable or changed");
  });

  it("presents only verified, declared independent business facts and withdraws them after tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-reader-report-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "Verify persisted request", level: "core", actions: [], assertions: [], oracles: ["request-stored"],
      httpOracles: [{ name: "request-stored", url: "http://127.0.0.1/read", query: {
        id: { source: "response", stepId: "step-001", field: "id", matchPointer: "/id" },
        token: { source: "response", stepId: "step-001", field: "token", matchPointer: "/token" } },
        statusPointer: "/status", successValues: ["created"], failureValues: ["missing"] }] });
    const summary: RunSummary = { runId: "reader-run", startedAt: "2026-10-19T00:00:00.000Z", status: "completed", verdict: "failed", charter,
      steps: [], assertions: [], oracles: [], artifacts: [], findings: [] };
    await store.startRun(summary);
    const source = { oracle: "request-stored", facts: [{ attempts: 1, observations: [{ at: "2026-10-19T00:00:01.000Z", status: 200, state: "failed", bodySha256: "a".repeat(64),
      facts: { scopeMatches: false, expected_id: "request-1", observed_id: "request-2", expected_token: "private-token", observed_token: "private-token" } }] }] };
    const sourcePath = await store.writeJson(summary.runId, "oracle-1-source", source);
    const recordedAt = "2026-10-19T00:00:01.000Z";
    const reportContent = { name: "request-stored", passed: false, message: "request-stored: failed after 1 observation(s)", evidence: [sourcePath],
      observedAt: recordedAt, verificationKind: "business" as const, recordedAt, sourceEvidenceCount: 1, sourceEvidenceArtifacts: [sourcePath] };
    const reportPath = await store.writeJson(summary.runId, "oracle-1", reportContent);
    summary.oracles.push({ ...reportContent, evidence: [sourcePath, reportPath] }); summary.artifacts.push(sourcePath, reportPath);
    const path = await store.writeReport(summary);
    const intact = await readFile(path, "utf8");
    expect(intact).toContain("Independent HTTP read · failed");
    expect(intact).toContain("request-1"); expect(intact).toContain("request-2");
    expect(intact).toContain("Current-record match: false");
    expect(intact).not.toContain("private-token");
    summary.oracles[0]!.passed = true;
    expect(await readFile(await store.writeReport(summary), "utf8")).toContain("Independent reader facts unavailable or changed");
    summary.oracles[0]!.passed = false;
    await writeFile(join(root, sourcePath), "changed reader facts");
    const changed = await readFile(await store.writeReport(summary), "utf8");
    expect(changed).not.toContain("Independent HTTP read · failed");
    expect(changed).toContain("Independent reader facts unavailable or changed");
  });

  it.each(["recorded", "partial"] as const)("withdraws %s ordinary Run video playback when its saved bytes change", async (status) => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-run-video-integrity-")); roots.push(root);
    const store = new EvidenceStore(root);
    const summary: RunSummary = { runId: "video-run", startedAt: "2026-10-19T00:00:00Z", status: "completed", verdict: "passed",
      charter: TestCharterSchema.parse({ intent: "Check recorded UI", level: "quick", actions: [], assertions: [] }), steps: [], assertions: [], oracles: [], artifacts: [], findings: [] };
    await store.startRun(summary);
    const artifact = await store.writeBuffer(summary.runId, "recording.webm", Buffer.from("original recording"));
    summary.recording = { status, artifact, ...(status === "partial" ? { stopReason: "duration-limit" as const } : {}), budget: { maxDurationMs: 1000, maxBytes: 1024 * 1024 } };
    summary.artifacts.push(artifact);
    expect(await readFile(await store.writeReport(summary), "utf8")).toContain('<video controls preload="metadata"');
    await writeFile(join(root, artifact), "changed recording");
    const markup = await readFile(await store.writeReport(summary), "utf8");
    expect(markup).not.toContain("<video");
    expect(markup).toContain("Requested recording unavailable");
    expect(markup).toContain("Recording budget: 1000 ms · 1048576 temporary bytes");
  });

  it("writes a bounded manifest for a Run and excludes the manifest itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-manifest-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "Manifest evidence", level: "quick", actions: [], assertions: [] });
    await store.startRun({ runId: "manifest-run", startedAt: "2026-10-12T00:00:00Z", status: "completed", verdict: "passed",
      charter, steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    await store.writeText("manifest-run", "note", "recorded");
    await store.writeReport({ runId: "manifest-run", startedAt: "2026-10-12T00:00:00Z", endedAt: "2026-10-12T00:00:01Z", status: "completed", verdict: "passed",
      charter, steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    const manifest = await store.writeManifest("manifest-run");
    expect(manifest.files).toBeGreaterThanOrEqual(3);
    const parsed = JSON.parse(await readFile(join(root, manifest.path), "utf8"));
    expect(parsed.files.some((item: { path: string }) => item.path.endsWith("/manifest.json"))).toBe(false);
    expect(parsed.files.some((item: { path: string }) => item.path.endsWith("/artifacts/note"))).toBe(true);
    expect(await store.readPreview("manifest-run", "manifest", 20_000)).toMatchObject({ truncated: false });
    expect((await store.verifyManifest("manifest-run", manifest.sha256)).status).toBe("intact");
    await writeFile(join(root, "manifest-run", "artifacts", "note"), "tampered");
    expect((await store.verifyManifest("manifest-run", manifest.sha256)).status).toBe("changed");
  });

  it("bounds previews of large logs without splitting a UTF-8 character", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-preview-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "Inspect preview", level: "quick", actions: [], assertions: [] });
    await store.startRun({ runId: "run-1", startedAt: "2026-10-12T00:00:00Z", status: "completed", verdict: "passed",
      charter, steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    await writeFile(join(root, "run-1", "events.jsonl"), `简历测试${"x".repeat(2_000_000)}`);
    expect(await store.readPreview("run-1", "events", 4)).toEqual({ content: "简历测试", truncated: true });
    await writeFile(join(root, "run-1", "report.html"), "A🙂B");
    expect(await store.readPreview("run-1", "report", 2)).toEqual({ content: "A", truncated: true });
    expect(await store.readPreview("run-1", "summary", 100_000)).toMatchObject({ truncated: false });
    await expect(store.readPreview("run-1", "events", 100_001)).rejects.toThrow("1–100000");
    await expect(store.readPreview("run-1", "events", -1)).rejects.toThrow("1–100000");
  });

  it("rejects redirected Run evidence and mismatched summary identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-preview-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "Inspect preview", level: "quick", actions: [], assertions: [] });
    await store.startRun({ runId: "run-1", startedAt: "2026-10-12T00:00:00Z", status: "completed", verdict: "passed",
      charter, steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    const outside = join(root, "private.txt");
    await writeFile(outside, "private evidence outside this Run");
    try {
      await symlink(outside, join(root, "run-1", "report.html"), "file");
      await expect(store.readPreview("run-1", "report", 100)).rejects.toThrow("redirected");
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    const summaryPath = join(root, "run-1", "run.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    await writeFile(summaryPath, JSON.stringify({ ...summary, runId: "run-2" }));
    await expect(store.loadSummary("run-1")).rejects.toThrow("identity mismatch");
    await truncate(summaryPath, 16 * 1024 * 1024 + 1);
    await expect(store.loadSummary("run-1")).rejects.toThrow("read limit");
    await mkdir(join(root, "other"));
    await symlink(join(root, "other"), join(root, "run-2"), process.platform === "win32" ? "junction" : "dir");
    await expect(store.readPreview("run-2", "summary", 100)).rejects.toThrow("redirected");
  });

  it("keeps the previous atomic snapshot on serialization failure and removes its temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-atomic-evidence-")); roots.push(root);
    const path = join(root, "journal.json");
    await atomicWriteJson(path, { owner: "run-1" });
    const previous = await readFile(path);
    await expect(atomicWriteJson(path, { invalid: 1n })).rejects.toThrow();
    expect(await readFile(path)).toEqual(previous);
    expect(await readdir(root)).toEqual(["journal.json"]);
  });

  it("hashes the exact sanitized bytes committed to an atomic artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-atomic-artifact-")); roots.push(root);
    const store = new EvidenceStore(root);
    const path = await store.writeJsonAtomic("run-1", "registration", { owner: "run-1", password: "must-not-persist" });
    const bytes = await readFile(join(root, path));
    expect(bytes.toString()).not.toContain("must-not-persist");
    const events = await collect(store.readEvents("run-1"));
    expect(events[0]?.payload).toMatchObject({ path, bytes: bytes.length, sha256: sha256(bytes) });
  });

  it("registers a completed recording only from this Run and rejects oversized files", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-recording-evidence-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "Record a Web flow", level: "quick", actions: [], assertions: [] });
    await store.startRun({ runId: "run-video", startedAt: new Date().toISOString(), status: "running",
      charter, steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    const file = join(root, "run-video", "artifacts", "recording.webm");
    const bytes = Buffer.from("synthetic recording bytes");
    await writeFile(file, bytes);
    await expect(store.recordExistingFile("run-video", "recording.webm", bytes.length - 1)).rejects.toThrow("oversized");
    expect(await store.recordExistingFile("run-video", "recording.webm")).toBe("run-video/artifacts/recording.webm");
    const events = await collect(store.readEvents("run-video"));
    expect(events.at(-1)?.payload).toMatchObject({ path: "run-video/artifacts/recording.webm", bytes: bytes.length, sha256: sha256(bytes) });
    await expect(store.recordExistingFile("run-video", "../private.webm")).rejects.toThrow("Invalid existing artifact identity");
  });

  it("redacts sensitive planned action values from the HTML Run report", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-report-plan-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "redact plan", level: "quick", actions: [
      { kind: "goto", url: "http://fixture.local/form?token=private" },
      { kind: "fill", selector: "#email", value: "private@example.invalid" },
      { kind: "setInputFiles", selector: "#file", files: [".proofkit/fixtures/private-resume.pdf"] },
      { kind: "observe" },
    ], assertions: [], sideEffectPolicy: "allow", metadata: { purpose: "session-network-capture", replanOfRunId: "source-run", replanSourceStepId: "step-001", replanOriginalSelector: "#old", replanApprovedSelector: "#new" } });
    const summary = { runId: "report-plan", execution: { adapter: "web", replayOfRunId: "source-run" }, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: "completed" as const,
      verdict: "inconclusive" as const, charter, steps: [], assertions: [], oracles: [], artifacts: [], findings: [] };
    await store.startRun(summary);
    const report = await readFile(await store.writeReport(summary), "utf8");
    expect(report).toContain("[REDACTED]");
    expect(report).toContain("[FIXTURE]");
    expect(report).toContain("http://fixture.local/form");
    expect(report).not.toContain("private@example.invalid");
    expect(report).not.toContain("token=private");
    expect(report).not.toContain("private-resume.pdf");
    expect(report).toContain("Replan lineage");
    expect(report).toContain("This verdict applies to the replacement Charter only");
    expect(report).not.toContain("Context only · no product verdict");
  });

  it("reports current artifact digest integrity and detects post-creation modification", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-report-integrity-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "check artifact integrity", level: "quick", actions: [{ kind: "observe" }], assertions: [] });
    const summary: RunSummary = { runId: "integrity-report", startedAt: new Date().toISOString(), status: "running",
      charter, steps: [], assertions: [], oracles: [], artifacts: [], findings: [] };
    await store.startRun(summary);
    const artifact = await store.writeJson(summary.runId, "proof", { fact: "observed" });
    summary.steps.push({ stepId: "step-001", action: charter.actions[0]!, status: "passed", artifacts: [artifact] });
    summary.artifacts.push(artifact);
    await store.writeSummary(summary);
    const intact = await readFile(await store.writeReport(summary), "utf8");
    expect(intact).toContain("1 verified · 0 changed · 0 missing · 0 unverified");
    expect(intact).toContain("integrity-verified");
    await writeFile(join(root, artifact), "tampered");
    const changed = await readFile(await store.writeReport(summary), "utf8");
    expect(changed).toContain("0 verified · 1 changed · 0 missing · 0 unverified");
    expect(changed).toContain("integrity-changed");
  });

  it("renders step timing and pairs network responses with their initiating request", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-report-timeline-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "show correlated evidence", level: "quick",
      actions: [{ kind: "click", selector: "#submit" }], assertions: [] });
    const summary: RunSummary = { runId: "timeline-report", startedAt: "2026-10-19T10:00:00.000Z", endedAt: "2026-10-19T10:00:02.000Z",
      status: "completed", verdict: "passed", charter,
      steps: [{ stepId: "step-001", action: charter.actions[0]!, status: "passed", artifacts: [] }],
      assertions: [], oracles: [], artifacts: [], findings: [] };
    await store.startRun(summary);
    await store.appendEvent({ runId: summary.runId, timestamp: "2026-10-19T10:00:00.100Z", type: "step.started", stepId: "step-001", payload: {} });
    await store.appendEvent({ runId: summary.runId, timestamp: "2026-10-19T10:00:00.500Z", type: "adapter.event", stepId: "step-001",
      payload: { eventType: "request", requestId: "request-1", method: "POST", url: "http://fixture.local/api/items" } });
    await store.appendEvent({ runId: summary.runId, timestamp: "2026-10-19T10:00:01.200Z", type: "adapter.event", stepId: "step-001",
      payload: { eventType: "response", requestId: "request-1", method: "POST", url: "http://fixture.local/api/items", status: 201 } });
    await store.appendEvent({ runId: summary.runId, timestamp: "2026-10-19T10:00:01.900Z", type: "step.completed", stepId: "step-001", payload: { status: "passed" } });

    const report = await readFile(await store.writeReport(summary), "utf8");
    expect(report).toContain("Started 2026-10-19T10:00:00.100Z");
    expect(report).toContain("Ended 2026-10-19T10:00:01.900Z");
    expect(report).toContain("Network requests (1)");
    expect(report).toContain("request-1 · POST http://fixture.local/api/items · response 201 at 2026-10-19T10:00:01.200Z");
    expect(report).not.toContain("request-1 · POST http://fixture.local/api/items · request");
  });

  it("withdraws network, step timing and image previews when a pinned event log changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-pinned-events-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "pin step evidence", level: "quick", actions: [{ kind: "click", selector: "#save" }] });
    const summary: RunSummary = { runId: "pinned-events", execution: { adapter: "web" }, startedAt: "2026-10-20T00:00:00.000Z",
      endedAt: "2026-10-20T00:00:01.000Z", status: "completed", verdict: "passed", charter,
      steps: [{ stepId: "step-001", action: charter.actions[0]!, status: "passed", artifacts: [] }], assertions: [], oracles: [], artifacts: [], findings: [] };
    await store.startRun(summary);
    const screenshot = await store.writeBuffer(summary.runId, "step-001.png", Buffer.from("known pixels"));
    summary.steps[0]!.artifacts.push(screenshot); summary.artifacts.push(screenshot);
    await store.appendEvent({ runId: summary.runId, timestamp: "2026-10-20T00:00:00.100Z", type: "step.started", stepId: "step-001", payload: {} });
    await store.appendEvent({ runId: summary.runId, timestamp: "2026-10-20T00:00:00.200Z", type: "adapter.event", stepId: "step-001",
      payload: { eventType: "request", requestId: "request-1", method: "POST", url: "http://fixture.local/__redacted__" } });
    summary.eventLog = await store.pinEventLog(summary.runId);
    await store.writeSummary(summary);
    const intact = await readFile(await store.writeReport(summary), "utf8");
    expect(intact).toContain("Event log: verified");
    expect(intact).toContain("Network requests (1)");
    expect(intact).toContain('<img src="artifacts/step-001.png"');
    const eventPath = join(root, summary.runId, "events.jsonl");
    const original = await readFile(eventPath);
    await writeFile(eventPath, Buffer.concat([original, Buffer.from('{"forged":true}\n')]));
    const changed = await readFile(await store.writeReport(await store.loadSummary(summary.runId)), "utf8");
    expect(changed).toContain("Event log: changed");
    expect(changed).toContain("artifact previews are withdrawn");
    expect(changed).not.toContain("Network requests (1)");
    expect(changed).not.toContain("Started 2026-10-20T00:00:00.100Z");
    expect(changed).not.toContain('<img src="artifacts/step-001.png"');
    await writeFile(eventPath, original);
    expect(await readFile(await store.writeReport(await store.loadSummary(summary.runId)), "utf8")).toContain("Event log: verified");
    const pin = store.pinEventLog.bind(store);
    const changedDuringRead = vi.spyOn(store, "pinEventLog").mockImplementationOnce(async (runId) => {
      const result = await pin(runId);
      await writeFile(eventPath, original.toString("utf8").replaceAll("request-1", "request-9"));
      return result;
    });
    try {
      const raced = await readFile(await store.writeReport(summary), "utf8");
      expect(raced).toContain("Event log: changed");
      expect(raced).not.toContain("request-9");
      expect(raced).not.toContain('<img src="artifacts/step-001.png"');
    } finally { changedDuringRead.mockRestore(); }
  });

  it("reads typed events from a run without loading the whole log", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-events-"));
    roots.push(root);
    const store = new EvidenceStore(root);
    await store.appendEvent({ runId: "run-1", timestamp: "2026-10-09T00:00:00Z", type: "adapter.event", payload: { eventType: "response", method: "GET", status: 200 } });
    await store.appendEvent({ runId: "run-1", timestamp: "2026-10-09T00:00:01Z", type: "run.completed", payload: { verdict: "passed" } });
    const events = [];
    for await (const event of store.readEvents("run-1")) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["adapter.event", "run.completed"]);
  });

  it("rejects malformed or cross-run event records", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-events-"));
    roots.push(root);
    const store = new EvidenceStore(root);
    await store.appendEvent({ runId: "run-1", timestamp: "2026-10-09T00:00:00Z", type: "run.started", payload: {} });
    const path = join(root, "run-1", "events.jsonl");
    await writeFile(path, "not-json\n");
    await expect(collect(store.readEvents("run-1"))).rejects.toThrow();
    await writeFile(path, `${JSON.stringify({ runId: "run-2", timestamp: "2026-10-09T00:00:00Z", type: "run.started", payload: {} })}\n`);
    await expect(collect(store.readEvents("run-1"))).rejects.toThrow("another run");
  });

  it("rejects an unavailable log and unsafe run IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-events-"));
    roots.push(root);
    const store = new EvidenceStore(root);
    await expect(collect(store.readEvents("missing"))).rejects.toThrow();
    await expect(collect(store.readEvents("../other"))).rejects.toThrow("Invalid run id");
  });
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}
