import { IntegrationResourceCleanupSchema, IntegrationResourceJournalSchema, IntegrationResourceSchema, IntegrationSetupPolicySchema, type IntegrationCleanup, type IntegrationResource, type IntegrationResourceCleanup, type IntegrationResourceJournal, type IntegrationSetupPolicy } from "@proofkit/contracts";
import type { EvidenceStore } from "@proofkit/evidence";
import { sha256 } from "@proofkit/evidence";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunEvent, TestCharter } from "@proofkit/contracts";

export type IntegrationCleanupContext = { runId: string; signal: AbortSignal };
export type IntegrationSetupHandle = {
  resources: IntegrationResource[];
  cleanup: (context: IntegrationCleanupContext) => Promise<IntegrationResourceCleanup[]>;
};
export type IntegrationSetupContext = IntegrationCleanupContext & {
  charter: TestCharter;
  environment: "test" | "staging" | "local";
  projectRoot?: string;
  workspaceRoot?: string;
  emit: (event: Omit<RunEvent, "runId">) => Promise<void>;
};
export type IntegrationSetup = (context: IntegrationSetupContext) => Promise<IntegrationSetupHandle | (() => void | Promise<void>) | undefined>;
export type IntegrationSetupEntry = { setup: IntegrationSetup; policy?: IntegrationSetupPolicy };
export type IntegrationRecoveryContext = IntegrationCleanupContext & {
  projectRoot: string;
  workspaceRoot: string;
  environment: "test" | "staging" | "local";
  resources: IntegrationResource[];
};
type JournalContext = Pick<IntegrationResourceJournal, "projectRoot" | "workspaceRoot" | "integration" | "environment">;

type OwnedHandle = {
  release?: (context: IntegrationCleanupContext) => unknown;
  legacy: boolean;
  resources: IntegrationResource[];
  valid: boolean;
};
const MAX_CLEANUP_MS = 5000;

/** Immediately owns returned handles, including handles with invalid registration metadata. */
export class IntegrationLifecycle {
  private readonly handles: OwnedHandle[] = [];
  private readonly issues: string[] = [];
  private readonly ids = new Set<string>();
  private timeoutMs = MAX_CLEANUP_MS;
  private attempted = false;
  private readonly pendingReleases = new Set<Promise<unknown>>();

  get hasPendingCleanup(): boolean { return this.pendingReleases.size > 0; }
  async whenCleanupSettles(): Promise<void> { await Promise.all([...this.pendingReleases]); }

  constructor(private readonly runId: string, private readonly store: EvidenceStore,
    private readonly journalContext: JournalContext = { environment: "test" }) {}

  /** Reuse removal/readback validation while writing evidence under a new recovery attempt. */
  static forRecovery(attemptId: string, store: EvidenceStore, resources: IntegrationResource[],
    cleanup: IntegrationSetupHandle["cleanup"], timeoutMs: number): IntegrationLifecycle {
    const owned = IntegrationResourceSchema.array().min(1).max(32).parse(resources);
    if (new Set(owned.map((resource) => resource.resourceId)).size !== owned.length) throw new Error("Duplicate recovery resource");
    const lifecycle = new IntegrationLifecycle(attemptId, store);
    lifecycle.begin(IntegrationSetupPolicySchema.parse({ sideEffect: "write", environments: ["test"], cleanupTimeoutMs: timeoutMs }));
    lifecycle.handles.push({ resources: owned, release: cleanup, legacy: false, valid: true });
    for (const resource of owned) lifecycle.ids.add(resource.resourceId);
    return lifecycle;
  }

  begin(policy?: IntegrationSetupPolicy): void {
    this.attempted = true;
    this.timeoutMs = Math.min(this.timeoutMs, policy?.cleanupTimeoutMs ?? MAX_CLEANUP_MS);
  }

  acquisitionFailed(): void { this.issues.push("Setup did not return a cleanup handle; resources may still be active."); }

  async register(value: unknown, policy?: IntegrationSetupPolicy): Promise<string | undefined> {
    const object = value && typeof value === "object" ? value as Partial<IntegrationSetupHandle> : undefined;
    const owned: OwnedHandle = {
      release: typeof value === "function" ? () => value() : typeof object?.cleanup === "function" ? (context) => object.cleanup!(context) : undefined,
      legacy: typeof value === "function",
      resources: [],
      valid: true,
    };
    this.handles.push(owned);
    if (value === undefined && policy?.sideEffect !== "write") return;
    if (owned.legacy && policy?.sideEffect !== "write") return;
    const parsed = IntegrationResourceSchema.array().max(32).safeParse(object?.resources);
    if (!object || !owned.release || !parsed.success || policy?.sideEffect === "write" && parsed.data.length === 0) {
      owned.valid = false;
      this.issues.push("Setup returned invalid resource registration or omitted required write cleanup evidence.");
      throw new Error("Invalid integration resource registration; cleanup will still be attempted.");
    }
    owned.resources = parsed.data;
    for (const resource of owned.resources) {
      if (this.ids.has(resource.resourceId) || this.ids.size >= 32) owned.valid = false;
      this.ids.add(resource.resourceId);
    }
    if (!owned.valid) {
      this.issues.push("Setup registered duplicate resources or exceeded the 32-resource limit.");
      throw new Error("Integration resource identity must be unique within a Run and limited to 32 resources.");
    }
    const journal = IntegrationResourceJournalSchema.parse({
      schemaVersion: 1, runId: this.runId, ...this.journalContext, cleanupTimeoutMs: this.timeoutMs,
      resources: this.handles.flatMap((handle) => handle.resources), registeredAt: new Date().toISOString(),
    });
    return this.store.writeJsonAtomic(this.runId, "integration-setup", journal);
  }

  async finish(): Promise<IntegrationCleanup> {
    if (!this.attempted) return { status: "not-required", declaredResources: 0, verifiedResources: 0 };
    const controller = new AbortController(); // Run cancellation must not suppress cleanup.
    const cleanupStartedAt = Date.now();
    let timedOut = false;
    let finishDeadline!: () => void;
    const deadline = new Promise<void>((resolve) => { finishDeadline = resolve; });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Integration cleanup deadline exceeded"));
      finishDeadline();
    }, this.timeoutMs);
    const results: Array<{ resourceId: string; status: string; releaseStartedAt: string; evidence?: IntegrationResourceCleanup["evidence"]; readback?: IntegrationResourceCleanup["readback"] }> = [];
    let failed = false;
    let legacy = false;
    let verified = 0;
    try {
      for (const owned of [...this.handles].reverse()) {
        legacy ||= owned.legacy;
        if (!owned.release) continue;
        const releaseStartedAt = Date.now();
        const pending = Promise.resolve().then(() => owned.release!({ runId: this.runId, signal: controller.signal }))
          .then((value) => ({ kind: "returned" as const, value }), () => ({ kind: "error" as const }));
        this.pendingReleases.add(pending);
        void pending.then(() => this.pendingReleases.delete(pending));
        const result = timedOut ? { kind: "timeout" as const } : await Promise.race([pending, deadline.then(() => ({ kind: "timeout" as const }))]);
        if (result.kind === "timeout") {
          this.issues.push("Cleanup timed out; resources may still be active.");
          continue;
        }
        if (result.kind === "error") {
          failed = true;
          this.issues.push("Cleanup threw an error; resource removal was not established.");
          continue;
        }
        if (owned.legacy || !owned.valid) continue;
        const parsed = IntegrationResourceCleanupSchema.array().max(32).safeParse(result.value);
        if (!parsed.success) {
          this.issues.push("Cleanup returned invalid resource observations.");
          continue;
        }
        const counts = new Map<string, number>();
        for (const item of parsed.data) counts.set(item.resourceId, (counts.get(item.resourceId) ?? 0) + 1);
        if (parsed.data.some((item) => !owned.resources.some((resource) => resource.resourceId === item.resourceId))) {
          this.issues.push("Cleanup reported a resource outside its setup registration.");
        }
        for (const resource of owned.resources) {
          const observation = parsed.data.find((item) => item.resourceId === resource.resourceId);
          if (!observation || counts.get(resource.resourceId) !== 1) {
            this.issues.push("Cleanup omitted a registered resource or returned duplicate observations.");
            results.push({ resourceId: resource.resourceId, status: "unverified", evidence: {}, releaseStartedAt: new Date(releaseStartedAt).toISOString() });
          } else {
            results.push({ ...observation, releaseStartedAt: new Date(releaseStartedAt).toISOString() });
            if (observation.status === "retained" || observation.readback?.exists === true) failed = true;
            else if (observation.status === "removed" && observation.readback?.exists === false
              && observation.readback.scope === resource.scope && Date.parse(observation.readback.observedAt) >= releaseStartedAt
              && Date.parse(observation.readback.observedAt) <= Date.now()) verified++;
            else this.issues.push("Removal lacks a current readback observation in the registered scope.");
          }
        }
      }
    } finally { clearTimeout(timer); }
    const declared = Math.min(this.ids.size, 32);
    const status: IntegrationCleanup["status"] = failed ? "failed"
      : timedOut || this.issues.length > 0 || verified < declared ? "unverified"
      : legacy ? "completed" : declared > 0 ? "verified" : "not-required";
    const artifact = await this.store.writeJson(this.runId, "integration-cleanup", {
      runId: this.runId, startedAt: new Date(cleanupStartedAt).toISOString(), endedAt: new Date().toISOString(),
      status, declaredResources: declared, verifiedResources: verified,
      resources: this.handles.flatMap((owned) => owned.resources).slice(0, 32),
      observations: results.slice(0, 32), issues: this.issues.slice(0, 32),
    });
    const digest = sha256(await readFile(resolve(this.store.rootDir, artifact)));
    return { status, declaredResources: declared, verifiedResources: verified, artifact, sha256: digest };
  }
}

// A handle acquired after the Run's grace period is released without rewriting its final evidence.
export async function releaseLateIntegration(value: unknown, runId: string): Promise<void> {
  const controller = new AbortController();
  let expire!: () => void;
  const deadline = new Promise<void>((resolve) => { expire = resolve; });
  const timer = setTimeout(() => { controller.abort(); expire(); }, MAX_CLEANUP_MS);
  try {
    const pending = Promise.resolve().then(async () => {
      if (typeof value === "function") await value();
      else if (value && typeof value === "object" && typeof (value as IntegrationSetupHandle).cleanup === "function") {
        await (value as IntegrationSetupHandle).cleanup({ runId, signal: controller.signal });
      }
    }).catch(() => {});
    await Promise.race([pending, deadline]);
  } finally { clearTimeout(timer); }
}

export function validateSetupPolicy(policy: unknown): IntegrationSetupPolicy {
  const result = IntegrationSetupPolicySchema.safeParse(policy);
  if (!result.success) throw new Error("Invalid integration setup policy");
  return result.data;
}
