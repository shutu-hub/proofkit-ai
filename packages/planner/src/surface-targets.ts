import { SurfaceTargetExpectationSchema, TestCharterSchema, type Action, type SurfaceObservedState, type SurfaceSnapshot, type SurfaceTargetExpectation, type TestCharter } from "@proofkit/contracts";

export function resolveObservedSurfaceTarget(target: { selector: string; observationId?: string }, snapshot?: SurfaceSnapshot, observations: SurfaceObservedState[] = []): SurfaceTargetExpectation | undefined {
  const states: Array<{ observationId?: string; snapshot: SurfaceSnapshot }> = snapshot ? [{ snapshot }] : observations;
  const selected = target.observationId ? states.filter((state) => state.observationId === target.observationId) : states;
  const candidates: SurfaceTargetExpectation[] = [];
  for (const state of selected) {
    const controls = (state.snapshot.controls ?? []).filter((control) => control.selector === target.selector || control.alternateSelectors?.includes(target.selector));
    if (controls.length > 1) return;
    const control = controls[0];
    if (!control) continue;
    let origin: string | undefined;
    try { const url = new URL(state.snapshot.url ?? ""); if (["http:", "https:"].includes(url.protocol)) origin = url.origin; } catch {}
    candidates.push(SurfaceTargetExpectationSchema.parse({ observedAt: state.snapshot.capturedAt, ...(origin ? { origin } : {}),
      ...(state.observationId ? { observationId: state.observationId } : {}), tag: control.tag, role: control.role,
      name: control.name ?? "", groupName: control.groupName ?? "", ...(control.inputType ? { inputType: control.inputType } : {}) }));
  }
  const signature = (candidate: SurfaceTargetExpectation) => JSON.stringify([candidate.tag, candidate.role, candidate.name, candidate.groupName, candidate.inputType, candidate.origin]);
  if (!candidates.length || candidates.some((candidate) => signature(candidate) !== signature(candidates[0]!))) return;
  return candidates[0];
}

export function bindObservedSurfaceTargets(charter: TestCharter, snapshot?: SurfaceSnapshot, observations: SurfaceObservedState[] = []): TestCharter {
  const bind = <Target extends { selector: string; observationId?: string; expectedTarget?: SurfaceTargetExpectation }>(target: Target): Target => {
    const { expectedTarget: ignored, observationId: requested, ...bare } = target;
    const expectedTarget = resolveObservedSurfaceTarget(target, snapshot, observations);
    const observationId = expectedTarget?.observationId ?? (snapshot || observations.length ? requested : undefined);
    return { ...bare, ...(observationId ? { observationId } : {}), ...(expectedTarget ? { expectedTarget } : {}) } as Target;
  };
  const actions = (items: Action[]): Action[] => items.map((action) => {
    if ("selector" in action) return bind(action);
    if (action.kind === "captureResponse") return { ...action, trigger: bind(action.trigger), ...(action.followUp ? { followUp: bind(action.followUp) } : {}) };
    return action;
  });
  const first = snapshot ?? observations[0]?.snapshot;
  return TestCharterSchema.parse({ ...charter, surfaceObservation: first ? { capturedAt: first.capturedAt,
    controlsTruncated: Boolean(snapshot ? snapshot.controlsTruncated : observations.some((state) => state.snapshot.controlsTruncated)) } : undefined,
    actions: actions(charter.actions),
    ...(charter.negativeCases ? { negativeCases: charter.negativeCases.map((negative) => ({ ...negative, actions: actions(negative.actions) })) } : {}) });
}
