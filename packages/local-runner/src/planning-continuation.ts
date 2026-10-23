import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PlanningContinuationPinSchema, PlanningInspectionPinSchema, RunModeSchema, SideEffectPolicySchema, TestCoverageSchema, TestLevelSchema,
  type PlanningContinuationPin, type PlanningInspectionPin } from "@proofkit/contracts";
import { sha256 } from "@proofkit/evidence";
import { resolveWithinWorkspace, sameProjectPath } from "@proofkit/project";
import { z } from "@proofkit/runner";

const MAX_BYTES = 256 * 1024;
const requestSchema = z.object({
  intent: z.string().min(1), adapter: z.enum(["web", "electron", "mobile"]), url: z.string().url().optional(),
  expect: z.array(z.string().min(1)).optional(), oracleNames: z.array(z.string().min(1)).optional(),
  mode: RunModeSchema.optional(), sideEffectPolicy: SideEffectPolicySchema, level: TestLevelSchema, coverage: TestCoverageSchema,
  sessionId: z.string().uuid().optional(), headful: z.boolean(),
}).strict();
const recordSchema = z.object({ version: z.literal(1), id: z.string().uuid(), projectRoot: z.string(), workspaceRoot: z.string(),
  savedAt: z.string().datetime(), round: z.number().int().min(1).max(10), request: requestSchema,
  inspections: PlanningInspectionPinSchema.array().min(1).max(10),
}).strict();
export type PlanningResumeRequest = z.infer<typeof requestSchema>;
type Record = z.infer<typeof recordSchema>;

async function planningDirectory(workspaceRoot: string, create: boolean): Promise<string> {
  const workspace = await realpath(workspaceRoot);
  let current = workspace;
  for (const name of [".proofkit", "planning"]) {
    current = join(current, name);
    if (create) await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !sameProjectPath(await realpath(current), current)) throw new Error("Planning continuation directory is unavailable or redirected");
  }
  if (!sameProjectPath(resolveWithinWorkspace(workspaceRoot, ".proofkit/planning"), current)) throw new Error("Planning continuation directory escaped its workspace");
  return current;
}

export async function savePlanningContinuation(workspaceRoot: string, projectRoot: string, request: PlanningResumeRequest,
  inspections: PlanningInspectionPin[], round: number): Promise<PlanningContinuationPin> {
  const id = randomUUID();
  const record = recordSchema.parse({ version: 1, id, projectRoot: resolve(projectRoot), workspaceRoot: resolve(workspaceRoot),
    savedAt: new Date().toISOString(), round, request, inspections: mergePlanningInspections(inspections, []) });
  const bytes = Buffer.from(JSON.stringify(record) + "\n");
  if (bytes.length > MAX_BYTES) throw new Error("Planning continuation exceeds the 256 KiB record budget");
  const directory = await planningDirectory(workspaceRoot, true);
  const file = await open(join(directory, id + ".json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return { id, sha256: sha256(bytes) };
}

export async function loadPlanningContinuation(workspaceRoot: string, projectRoot: string, input: PlanningContinuationPin): Promise<Record> {
  const pin = PlanningContinuationPinSchema.parse(input);
  try {
    const directory = await planningDirectory(workspaceRoot, false);
    const path = join(directory, pin.id + ".json"); const direct = await lstat(path);
    if (!direct.isFile() || direct.isSymbolicLink() || direct.size < 1 || direct.size > MAX_BYTES || !sameProjectPath(await realpath(path), path)) throw new Error("unavailable");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || before.dev !== direct.dev || before.ino !== direct.ino || before.size !== direct.size) throw new Error("changed");
      const bytes = Buffer.alloc(before.size + 1); let length = 0;
      while (length < bytes.length) { const chunk = await file.read(bytes, length, bytes.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
      const after = await file.stat(); const current = await lstat(path);
      if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || current.dev !== before.dev || current.ino !== before.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs
        || sha256(bytes.subarray(0, length)) !== pin.sha256) throw new Error("changed");
      const record = recordSchema.parse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
      if (record.id !== pin.id || !sameProjectPath(resolve(projectRoot), record.projectRoot) || !sameProjectPath(resolve(workspaceRoot), record.workspaceRoot)) throw new Error("foreign");
      mergePlanningInspections(record.inspections, []);
      return record;
    } finally { await file.close(); }
  } catch { throw new Error("Planning continuation is missing, changed, redirected or belongs to another project/workspace"); }
}

export function mergePlanningInspections(saved: PlanningInspectionPin[], additional: PlanningInspectionPin[]): PlanningInspectionPin[] {
  const merged = new Map<string, PlanningInspectionPin>();
  for (const raw of [...saved, ...additional]) {
    const pin = PlanningInspectionPinSchema.parse(raw); const previous = merged.get(pin.runId);
    if (previous && previous.manifestSha256 !== pin.manifestSha256) throw new Error("Planning continuation inspection conflicts with its original digest");
    merged.set(pin.runId, pin);
  }
  if (merged.size > 10) throw new Error("Planning continuation exceeds the ten-state observation budget");
  return [...merged.values()];
}

export function assertResumeRequirements(saved: PlanningResumeRequest, supplied: Partial<PlanningResumeRequest>): void {
  for (const key of Object.keys(requestSchema.shape) as Array<keyof PlanningResumeRequest>) {
    const value = supplied[key]; if (value === undefined) continue;
    const expected = saved[key];
    const actualValue = (key === "expect" || key === "oracleNames") && Array.isArray(value) ? [...value].sort() : value;
    const expectedValue = (key === "expect" || key === "oracleNames") && Array.isArray(expected) ? [...expected].sort() : expected;
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) throw new Error("Planning continuation conflicts with the saved " + key + "; start a new plan to change requirements");
  }
}
