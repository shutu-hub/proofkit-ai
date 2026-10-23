import { mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestCharterSchema } from "@proofkit/contracts";
import { EvidenceStore } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(runId = "manifest-run") {
  const root = await mkdtemp(join(tmpdir(), "proofkit-manifest-check-")); roots.push(root);
  const store = new EvidenceStore(root);
  await store.startRun({ runId, startedAt: new Date().toISOString(), status: "completed", verdict: "inconclusive",
    charter: TestCharterSchema.parse({ intent: "verify exported evidence", level: "quick", actions: [], assertions: [] }),
    steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
  const artifact = await store.writeText(runId, "note", "recorded fact");
  const manifest = await store.writeManifest(runId);
  const path = join(root, manifest.path);
  const parsed = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number; runId: string; generatedAt: string; files: Array<{ path: string; bytes: number; sha256: string }> };
  return { root, store, runId, artifact, manifest, path, parsed };
}

describe("Run manifest verification", () => {
  it.each([null, [], "text", 1, {}, { schemaVersion: 1, runId: "manifest-run", files: [] }])("rejects malformed or empty manifest %j without throwing", async (value) => {
    const fixtureState = await fixture();
    await writeFile(fixtureState.path, JSON.stringify(value));
    expect(await fixtureState.store.verifyManifest(fixtureState.runId)).toMatchObject({ status: "unverified", manifestVerified: false });
  });

  it.each(["../outside", "manifest-run/../outside", "manifest-run/artifacts\\note", "manifest-run/artifacts/note:stream", "manifest-run/manifest.json"])("rejects unsafe manifest path %s", async (path) => {
    const fixtureState = await fixture();
    fixtureState.parsed.files.push({ path, bytes: 0, sha256: "a".repeat(64) });
    await writeFile(fixtureState.path, JSON.stringify(fixtureState.parsed));
    expect(await fixtureState.store.verifyManifest(fixtureState.runId)).toMatchObject({ status: "unverified", manifestVerified: false, files: [] });
  });

  it("rejects duplicate entries and a manifest omitting its Run summary", async () => {
    const fixtureState = await fixture();
    const original = [...fixtureState.parsed.files];
    fixtureState.parsed.files.push(original[0]!);
    await writeFile(fixtureState.path, JSON.stringify(fixtureState.parsed));
    expect((await fixtureState.store.verifyManifest(fixtureState.runId)).status).toBe("unverified");
    fixtureState.parsed.files = original.filter((file) => !file.path.endsWith("/run.json"));
    await writeFile(fixtureState.path, JSON.stringify(fixtureState.parsed));
    expect((await fixtureState.store.verifyManifest(fixtureState.runId)).status).toBe("unverified");
  });

  it("validates every row before reading evidence", async () => {
    const fixtureState = await fixture();
    const original = [...fixtureState.parsed.files];
    for (const entry of [null, { path: "manifest-run/run.json", bytes: -1, sha256: "a".repeat(64) },
      { path: "manifest-run/run.json", bytes: 0, sha256: "invalid" }]) {
      await writeFile(fixtureState.path, JSON.stringify({ ...fixtureState.parsed, files: [...original, entry] }));
      expect(await fixtureState.store.verifyManifest(fixtureState.runId)).toMatchObject({ status: "unverified", files: [] });
    }
  });

  it("bounds manifest input, file count and declared byte totals", async () => {
    const fixtureState = await fixture();
    await truncate(fixtureState.path, 16 * 1024 * 1024 + 1);
    expect(await fixtureState.store.verifyManifest(fixtureState.runId)).toMatchObject({ status: "unverified", manifestVerified: false });
    await writeFile(fixtureState.path, JSON.stringify({ ...fixtureState.parsed, files: Array.from({ length: 10_001 }, () => fixtureState.parsed.files[0]!) }));
    expect(await fixtureState.store.verifyManifest(fixtureState.runId)).toMatchObject({ status: "unverified", omittedFiles: 10_001, files: [] });
    await writeFile(fixtureState.path, JSON.stringify({ ...fixtureState.parsed, files: Array.from({ length: 5 }, (_, index) => ({
      path: index === 0 ? "manifest-run/run.json" : `manifest-run/artifacts/large-${index}`,
      bytes: 64 * 1024 * 1024, sha256: "a".repeat(64),
    })) }));
    expect(await fixtureState.store.verifyManifest(fixtureState.runId)).toMatchObject({ status: "unverified", files: [] });
  });

  it("reports missing artifacts and distinguishes an absent manifest", async () => {
    const fixtureState = await fixture();
    await rm(join(fixtureState.root, fixtureState.artifact));
    const audit = await fixtureState.store.verifyManifest(fixtureState.runId, fixtureState.manifest.sha256);
    expect(audit.status).toBe("missing");
    expect(audit.files.find((file) => file.path === fixtureState.artifact)?.status).toBe("missing");
    await rm(fixtureState.path);
    expect(await fixtureState.store.verifyManifest(fixtureState.runId)).toMatchObject({ status: "missing", manifestVerified: false });
    expect((await new EvidenceStore(join(fixtureState.root, "absent")).verifyManifest(fixtureState.runId)).status).toBe("missing");
  });

  it("detects files added or removed from the exported inventory", async () => {
    const fixtureState = await fixture();
    await writeFile(join(fixtureState.root, fixtureState.runId, "artifacts", "extra"), "new evidence");
    expect(await fixtureState.store.verifyManifest(fixtureState.runId, fixtureState.manifest.sha256)).toMatchObject({
      status: "changed", unexpectedFiles: ["manifest-run/artifacts/extra"],
    });
    await rm(join(fixtureState.root, fixtureState.runId, "artifacts", "extra"));
    fixtureState.parsed.files = fixtureState.parsed.files.filter((file) => file.path !== fixtureState.artifact);
    await writeFile(fixtureState.path, JSON.stringify(fixtureState.parsed));
    expect(await fixtureState.store.verifyManifest(fixtureState.runId)).toMatchObject({ status: "changed", unexpectedFiles: [fixtureState.artifact] });
  });

  it("refuses oversized artifacts during creation and verification", async () => {
    const fixtureState = await fixture();
    await truncate(join(fixtureState.root, fixtureState.artifact), 64 * 1024 * 1024 + 1);
    const audit = await fixtureState.store.verifyManifest(fixtureState.runId);
    expect(audit.status).toBe("unverified");
    expect(audit.files.find((file) => file.path === fixtureState.artifact)?.status).toBe("unverified");
    expect(audit.files.find((file) => file.path === fixtureState.artifact)?.actualSha256).toBeUndefined();
    await expect(fixtureState.store.writeManifest(fixtureState.runId)).rejects.toThrow("byte budget");
  });

  it("rejects directory redirects before hashing their files", async () => {
    const fixtureState = await fixture();
    const artifacts = join(fixtureState.root, fixtureState.runId, "artifacts");
    const redirected = join(fixtureState.root, "outside");
    await rename(artifacts, redirected);
    await symlink(redirected, artifacts, process.platform === "win32" ? "junction" : "dir");
    const audit = await fixtureState.store.verifyManifest(fixtureState.runId);
    expect(audit.status).toBe("unverified");
    expect(audit.files.find((file) => file.path === fixtureState.artifact)?.actualSha256).toBeUndefined();
    await expect(fixtureState.store.writeManifest(fixtureState.runId)).rejects.toThrow();
    await rm(artifacts);
    await mkdir(artifacts);
    await rename(join(fixtureState.root, fixtureState.runId), join(fixtureState.root, "redirected-run"));
    await symlink(join(fixtureState.root, "redirected-run"), join(fixtureState.root, fixtureState.runId), process.platform === "win32" ? "junction" : "dir");
    expect(await fixtureState.store.verifyManifest(fixtureState.runId)).toMatchObject({ status: "unverified", manifestSha256: "" });
  });

  it("retains the external digest pin and validates the supplied pin", async () => {
    const fixtureState = await fixture("Run-MixedCase");
    expect(await fixtureState.store.verifyManifest(fixtureState.runId, fixtureState.manifest.sha256.toUpperCase())).toMatchObject({ status: "intact", manifestVerified: true });
    expect(await fixtureState.store.verifyManifest(fixtureState.runId, "0".repeat(64))).toMatchObject({ status: "changed", manifestVerified: false });
    await expect(fixtureState.store.verifyManifest(fixtureState.runId, "invalid")).rejects.toThrow("Invalid expected manifest");
  });

  it("bounds deep directory trees even when they contain no additional files", async () => {
    const fixtureState = await fixture();
    await mkdir(join(fixtureState.root, fixtureState.runId, ...Array.from({ length: 33 }, () => "d")), { recursive: true });
    await expect(fixtureState.store.writeManifest(fixtureState.runId)).rejects.toThrow("depth limit");
    expect((await fixtureState.store.verifyManifest(fixtureState.runId)).status).toBe("unverified");
  });
});
