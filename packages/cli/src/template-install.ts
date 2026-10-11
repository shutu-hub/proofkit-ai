import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject, loadConfigForContext, resolveProjectContext, resolveWithinWorkspace } from "@proofkit/project";

type TemplateManifest = { version: number; files: string[] };
type TemplateFile = { name: string; destination: string; content: Buffer; status: "installed" | "reused" };

/** Export the reviewed reference files without importing or executing connector code. */
export async function installAihrTemplate(projectRoot: string, workspaceRoot?: string) {
  const context = resolveProjectContext(projectRoot, { workspaceRoot });
  const location = relative(context.projectRoot, context.workspaceRoot);
  if (!location || (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location))) {
    throw new Error("AIHR examples require a test workspace outside the tested source tree");
  }
  loadConfigForContext(context);

  const { manifest, sourceRoot } = await templateAssets();
  const files: TemplateFile[] = await Promise.all(manifest.files.map(async (name) => {
    const destination = resolveWithinWorkspace(context.workspaceRoot, `.proofkit/${name}`);
    const content = await readFile(resolve(sourceRoot, name));
    let status: TemplateFile["status"] = "installed";
    try {
      const existing = await lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink() || !(await readFile(destination)).equals(content)) {
        throw new Error(`AIHR example conflicts with an existing workspace file: ${name}`);
      }
      status = "reused";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { name, destination, content, status };
  }));

  // Install the entry module before initProject so its generic starter never
  // replaces or conflicts with the selected reference connector.
  const entry = files.find((file) => file.name === "integration.mjs");
  if (!entry) throw new Error("AIHR template is missing integration.mjs");
  await publishFile(entry);
  await initProject(context.projectRoot, { workspaceRoot: context.workspaceRoot });
  for (const file of files) if (file !== entry) await publishFile(file);

  return {
    template: "aihr", status: files.some((file) => file.status === "installed") ? "installed" : "reused",
    projectRoot: context.projectRoot, workspaceRoot: context.workspaceRoot, testVerdict: "not-asserted",
    files: files.map(({ name, destination, status }) => ({ name, path: destination, status })),
    next: [
      "Review the workspace connector before starting ProofKit; it is trusted local JavaScript.",
      "Configure isolated AIHR Web/Electron endpoints, test identity, sanitized fixture and gateway readers.",
      "Review and adapt a Charter's observed UI action, positive assertion and independent business Oracle before catalog registration.",
      "Run scope and environment inspection, then execute only the reviewed test scope.",
    ],
  };
}

async function templateAssets(): Promise<{ manifest: TemplateManifest; sourceRoot: string }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const bundled = join(moduleDir, "templates", "aihr", "manifest.json");
  const development = resolve(moduleDir, "../../../templates/aihr/manifest.json");
  const manifestPath = existsSync(bundled) ? bundled : development;
  const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!value || typeof value !== "object") throw new Error("AIHR template manifest is invalid");
  const manifest = value as TemplateManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 32
    || !manifest.files.includes("integration.mjs") || new Set(manifest.files).size !== manifest.files.length
    || manifest.files.some((file) => typeof file !== "string" || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.(?:mjs|yml)$/.test(file))) {
    throw new Error("AIHR template manifest is invalid");
  }
  return { manifest, sourceRoot: manifestPath === bundled ? dirname(bundled) : resolve(moduleDir, "../../../.proofkit") };
}

async function publishFile(file: TemplateFile): Promise<void> {
  if (file.status === "reused") return;
  await mkdir(dirname(file.destination), { recursive: true });
  const temporary = join(dirname(file.destination), `.${basename(file.destination)}-${randomUUID()}.tmp`);
  await writeFile(temporary, file.content, { flag: "wx" });
  try {
    await link(temporary, file.destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST"
      || !(await readFile(file.destination)).equals(file.content)) throw error;
    file.status = "reused";
  } finally {
    await unlink(temporary);
  }
}
