import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { installAihrTemplate } from "./template-install.js";

describe("source-checkout AIHR template", () => {
  it("installs the reference in an external workspace without changing the source", async () => {
    const tempParent = await realpath(tmpdir());
    const scratch = await mkdtemp(join(tempParent, "proofkit-aihr-template-"));
    try {
      const source = join(scratch, "source");
      const workspace = join(scratch, "external workspace");
      await mkdir(source);
      const first = await installAihrTemplate(source, workspace);
      expect(first).toMatchObject({ status: "installed", testVerdict: "not-asserted" });
      expect(first.files).toHaveLength(8);
      expect(await readFile(join(workspace, ".proofkit", "integration.mjs"), "utf8"))
        .toContain("createIntegration");
      expect((await installAihrTemplate(source, workspace)).status).toBe("reused");
      expect(await readdir(source)).toEqual([]);
      expect(relative(source, workspace).startsWith(".." + sep)).toBe(true);
    } finally {
      const canonical = await realpath(scratch);
      if (relative(tempParent, canonical).includes(sep) || !basename(canonical).startsWith("proofkit-aihr-template-")) {
        throw new Error("Refusing to delete an unexpected template fixture directory");
      }
      await rm(canonical, { recursive: true, force: true });
    }
  });
});
