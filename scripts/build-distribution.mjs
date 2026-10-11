import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outdir = resolve(projectRoot, "bundle");
if (dirname(outdir) !== projectRoot) throw new Error("Distribution output escaped the project root");
const manifest = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const external = Object.keys(manifest.dependencies ?? {}).flatMap((name) => [name, `${name}/*`]);
await rm(outdir, { recursive: true, force: true });

const result = await build({
  entryPoints: [
    resolve(projectRoot, "packages/cli/dist/main.js"),
    resolve(projectRoot, "packages/mcp/dist/server.js"),
  ],
  outdir,
  entryNames: "[name]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external,
  metafile: true,
  logLevel: "info",
});
const bundledDependencies = Object.keys(result.metafile.inputs).filter((path) => path.includes("node_modules/"));
if (bundledDependencies.length > 0) {
  throw new Error(`Distribution bundled undeclared runtime dependencies: ${bundledDependencies.join(", ")}`);
}

const templateManifest = JSON.parse(await readFile(resolve(projectRoot, "templates/aihr/manifest.json"), "utf8"));
if (templateManifest.version !== 1 || !Array.isArray(templateManifest.files) || templateManifest.files.length < 1
  || templateManifest.files.length > 32 || templateManifest.files.some((file) =>
    typeof file !== "string" || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.(?:mjs|yml)$/.test(file))) {
  throw new Error("Invalid AIHR template manifest");
}
const templateOutput = resolve(outdir, "templates/aihr");
await mkdir(templateOutput, { recursive: true });
await copyFile(resolve(projectRoot, "templates/aihr/manifest.json"), join(templateOutput, "manifest.json"));
for (const file of templateManifest.files) {
  const destination = resolve(templateOutput, file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(projectRoot, ".proofkit", file), destination);
}
