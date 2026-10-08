import { access } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProofkitConfig } from "@proofkit/contracts";
import type { ProjectIntegration } from "@proofkit/runner";

const DEFAULT_INTEGRATION_PATH = ".proofkit/integration.mjs";

export type ProjectIntegrationFactoryContext = {
  root: string;
  config: ProofkitConfig;
};

export async function loadProjectIntegration(
  root: string,
  config: ProofkitConfig,
  explicitPath?: string,
): Promise<ProjectIntegration | undefined> {
  const projectRoot = resolve(root);
  const configuredPath = explicitPath ?? config.integration.path ?? DEFAULT_INTEGRATION_PATH;
  const path = resolveWithinRoot(projectRoot, configuredPath);
  if (!(await fileExists(path))) return undefined;
  if (![".mjs", ".js", ".cjs"].includes(extname(path).toLowerCase())) {
    throw new Error("ProofKit integrations must be JavaScript modules (.mjs, .js or .cjs)");
  }

  const loaded = await import(`${pathToFileURL(path).href}?proofkit=${Date.now()}`) as {
    default?: unknown;
    integration?: unknown;
    createIntegration?: (context: ProjectIntegrationFactoryContext) => unknown | Promise<unknown>;
  };
  const candidate = loaded.createIntegration
    ? await loaded.createIntegration({ root: projectRoot, config })
    : loaded.default ?? loaded.integration;
  return validateIntegration(candidate, path);
}

function validateIntegration(value: unknown, path: string): ProjectIntegration {
  if (!value || typeof value !== "object") throw new Error(`Integration ${path} must export an object`);
  const integration = value as Partial<ProjectIntegration>;
  if (typeof integration.name !== "string" || integration.name.trim().length === 0) {
    throw new Error(`Integration ${path} must export a non-empty name`);
  }
  if (integration.capabilities !== undefined && !Array.isArray(integration.capabilities)) {
    throw new Error(`Integration ${path} capabilities must be an array`);
  }
  if (integration.oracles !== undefined && !Array.isArray(integration.oracles)) {
    throw new Error(`Integration ${path} oracles must be an array`);
  }
  if (integration.setup !== undefined && typeof integration.setup !== "function") {
    throw new Error(`Integration ${path} setup must be a function`);
  }
  for (const capability of integration.capabilities ?? []) {
    if (!capability || typeof capability !== "object" || typeof capability.name !== "string" || typeof capability.description !== "string" || !["none", "read", "write"].includes(capability.sideEffect ?? "") || !Array.isArray(capability.environments) || !capability.environments.every((environment) => ["test", "staging", "local"].includes(environment)) || !Number.isInteger(capability.timeoutMs) || capability.timeoutMs <= 0 || !capability.inputSchema || typeof capability.inputSchema.parse !== "function" || !capability.outputSchema || typeof capability.outputSchema.parse !== "function" || typeof capability.execute !== "function" || typeof capability.evidence !== "function") {
      throw new Error(`Integration ${path} contains an invalid capability`);
    }
  }
  for (const oracle of integration.oracles ?? []) {
    if (!oracle || typeof oracle !== "object" || typeof oracle.name !== "string" || typeof oracle.check !== "function") {
      throw new Error(`Integration ${path} contains an invalid oracle`);
    }
  }
  const capabilityNames = (integration.capabilities ?? []).map((capability) => capability.name);
  if (new Set(capabilityNames).size !== capabilityNames.length) throw new Error(`Integration ${path} contains duplicate capability names`);
  const oracleNames = (integration.oracles ?? []).map((oracle) => oracle.name);
  if (new Set(oracleNames).size !== oracleNames.length) throw new Error(`Integration ${path} contains duplicate oracle names`);
  return integration as ProjectIntegration;
}

function resolveWithinRoot(root: string, candidate: string): string {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Integration path must stay within the project root");
  return absolute;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
