import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
