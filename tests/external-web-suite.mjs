import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadExternalSuite(path, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) throw new Error("--suite-sha256 must pin the reviewed external module");
  const absolute = resolve(path);
  const info = await lstat(absolute);
  const canonical = await realpath(absolute);
  const samePath = process.platform === "win32" ? canonical.toLowerCase() === absolute.toLowerCase() : canonical === absolute;
  if (!samePath || !info.isFile() || info.size > 128 * 1024 || !absolute.endsWith(".mjs")) throw new Error("External suite must be an owned regular .mjs file of at most 128 KiB");
  const bytes = await readFile(absolute);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error("External suite digest changed");
  const module = await import(`${pathToFileURL(absolute).href}?sha256=${expectedSha256}`);
  if (createHash("sha256").update(await readFile(absolute)).digest("hex") !== expectedSha256) throw new Error("External suite changed during import");
  if (!Array.isArray(module.cases) || module.cases.length < 1 || module.cases.length > 12 || typeof module.prepare !== "function") {
    throw new Error("External suite requires 1-12 declared cases and a prepare function");
  }
  const evaluationScope = module.evaluationScope ?? "reviewed-external";
  if (!["reviewed-external", "unseen-holdout"].includes(evaluationScope)) throw new Error("External suite evaluationScope must be reviewed-external or unseen-holdout");
  if (evaluationScope === "unseen-holdout" && module.holdoutAttestation !== true) throw new Error("An unseen holdout suite requires an explicit holdoutAttestation=true");
  const cases = module.cases.map((item) => {
    if (!item || !/^[a-z][a-z0-9-]{0,47}$/.test(item.id ?? "") || typeof item.intent !== "string" || !item.intent.trim()
      || item.intent.length > 2000 || !Array.isArray(item.expect) || item.expect.length < 1 || item.expect.length > 8
      || item.expect.some((text) => typeof text !== "string" || !text.trim() || text.length > 256)) throw new Error("Invalid external case identity, intent or reviewed visible outcomes");
    return { id: item.id, intent: item.intent, expect: [...item.expect] };
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("External case identities must be unique");
  return { path: absolute, sha256: expectedSha256, evaluationScope, cases, prepare: module.prepare };
}
