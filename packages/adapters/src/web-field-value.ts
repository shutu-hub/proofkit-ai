import type { Page } from "playwright-core";
import { changedSurfaceTargetFields, WaitForValueActionSchema, type Action } from "@proofkit/contracts";
import { InconclusiveError, type SurfaceActionContext } from "@proofkit/runner";
import { inspectWebTargetIdentity, withWebActionTarget } from "./web-target.js";

export async function waitForWebFieldValue(page: Page, input: Extract<Action, { kind: "waitForValue" }>, context?: SurfaceActionContext) {
  const action = WaitForValueActionSchema.parse(input);
  if (typeof action.value !== "string" || action.value.length > 4096 || action.stableForMs >= action.timeoutMs) {
    throw new InconclusiveError("surface-value-configuration", "A bounded resolved value and a stability window shorter than the timeout are required");
  }
  const expected = action.value;
  const controller = new AbortController();
  const cancel = () => controller.abort(context?.signal?.reason);
  if (context?.signal?.aborted) cancel(); else context?.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new InconclusiveError("surface-value-not-stable", "The expected field value was not continuously observed within the declared deadline")), action.timeoutMs);
  const signal = controller.signal;
  const start = performance.now();
  try {
    signal.throwIfAborted();
    return await within(withWebActionTarget(page, action.selector, action.expectedTarget, { ...context, signal }, async (target) => {
      let matchedSince: number | undefined;
      let previousSampleAt: number | undefined;
      let identity: string | undefined;
      let polls = 0;
      while (true) {
        signal.throwIfAborted();
        if (await within(page.locator(action.selector).count(), signal) !== 1) throw new InconclusiveError("surface-value-target-changed", "The value-check selector is no longer unique");
        const observed = await within(target.evaluate((element, expected) => {
          const supported = element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement && !element.multiple
            || element instanceof HTMLInputElement && !["file", "hidden", "checkbox", "radio", "button", "submit", "reset", "image"].includes(element.type);
          if (!supported) return { supported: false, connected: element.isConnected, visible: false, matched: false };
          const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          return { supported: true, connected: field.isConnected,
            visible: field.getClientRects().length > 0 && getComputedStyle(field).visibility !== "hidden" && field.getAttribute("aria-hidden") !== "true",
            matched: field.value === expected };
        }, expected), signal);
        polls++;
        if (!observed.supported) throw new InconclusiveError("surface-value-unsupported", "Value checkpoints require one native input, textarea or single select");
        if (!observed.connected || !observed.visible) throw new InconclusiveError("surface-value-target-changed", "The value-check target disappeared or became hidden");
        const current = await within(inspectWebTargetIdentity(page, target), signal);
        const currentIdentity = JSON.stringify(current);
        if (action.expectedTarget && changedSurfaceTargetFields(action.expectedTarget, current.actual, current.actualOrigin).length
          || identity !== undefined && identity !== currentIdentity) throw new InconclusiveError("surface-value-target-changed", "The value-check control identity changed during observation");
        identity = currentIdentity;
        const now = performance.now();
        matchedSince = observed.matched ? previousSampleAt !== undefined && now - previousSampleAt <= 250 ? matchedSince ?? now : now : undefined;
        previousSampleAt = now;
        if (matchedSince !== undefined && now - matchedSince >= action.stableForMs) {
          return { matched: true, stableForMs: Math.floor(now - matchedSince), polls, observedForMs: Math.floor(now - start),
            actualValueRetained: false, scope: "sampled-native-control-value", businessAcceptance: false };
        }
        await within(new Promise((resolve) => setTimeout(resolve, 50)), signal);
      }
    }, "visible", action.timeoutMs), signal);
  } finally {
    clearTimeout(timeout);
    context?.signal?.removeEventListener("abort", cancel);
  }
}

async function within<Result>(pending: Promise<Result>, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) { void pending.catch(() => {}); throw signal.reason; }
  let cancel!: () => void;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason); signal.addEventListener("abort", cancel, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", cancel); }
}
