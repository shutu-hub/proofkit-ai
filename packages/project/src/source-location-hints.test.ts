import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { verifySourceLocationHints } from "./source-location-hints.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("accepts only existing repository-relative files and rejects traversal, absolute paths, and symlink escapes", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "proofkit-source-hints-"));
  roots.push(fixture);
  const project = join(fixture, "source");
  const outside = join(fixture, "outside");
  await mkdir(join(project, "services"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(project, "services", "resume.go"), "package resume\n");
  await writeFile(join(outside, "escape.go"), "package escape\n");
  await symlink(outside, join(project, "external"), process.platform === "win32" ? "junction" : "dir");

  const checked = await verifySourceLocationHints(project, [
    "services/resume.go", "services/resume.go", "services/missing.go", "services", "../outside/escape.go",
    join(outside, "escape.go"), "C:/outside/escape.go", "external/escape.go", "services//resume.go",
    "services/./resume.go", "services\\resume.go", "https://example.test/file", "",
  ]);
  expect(checked).toEqual(["services/resume.go"]);
});

it("bounds connector hints before filesystem checks", async () => {
  const project = await mkdtemp(join(tmpdir(), "proofkit-source-hint-limit-"));
  roots.push(project);
  await writeFile(join(project, "last.go"), "package last\n");
  expect(await verifySourceLocationHints(project, [...Array.from({ length: 32 }, (_, index) => `missing-${index}.go`), "last.go"]))
    .toEqual([]);
});
