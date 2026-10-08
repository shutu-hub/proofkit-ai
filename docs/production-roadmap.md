# ProofKit Production Roadmap

This roadmap keeps the product focused on one promise: a local test run should produce a small, reviewable verdict backed by evidence from the UI, process and business boundaries.

## Product boundary

ProofKit is not a replacement for Playwright, Maestro, Appium or a browser agent. Those projects already own surface control. ProofKit owns the control plane that joins a user goal, a project integration, a repeatable run, independent business observations and evidence.

## Phase 0: executable kernel — complete

**Goal:** run a reviewable charter on Web and Electron.

- Playwright Web and Electron/CDP adapters.
- CLI and MCP over one Local Runner.
- YAML Test Charter and schema validation.
- JSONL events, snapshots, screenshots, reports and evidence verdicts.
- Read-only HTTP oracles and bounded polling.
- Persisted `TestMission` task graphs with approval, cancellation, replay and evidence references.
- Mission-level MCP and CLI commands over the same Local Runner.

**Gate:** local Web and Electron smoke flows pass with artifacts and CI can reproduce the run.

## Phase 1: trusted local execution — current

**Goal:** make a failed or interrupted run safe to repeat and easy to integrate into a real repository.

- Load a project-owned `.proofkit/integration.mjs` module.
- Merge typed capabilities, business oracles and setup/cleanup into the same Runner lifecycle.
- Enforce a total run deadline and external cancellation.
- Expose cancellation through the CLI and MCP.
- Treat adapter, process and integration cleanup failures as non-green results.
- Keep Agent tool failures as suspected test findings until an independent product oracle confirms a defect.
- Never let a rejected Mission promise leave a durable mission in an unexplained running state.

**Gate:** a fixture integration is loaded without a hosted service; a slow run produces a `cancelled` verdict; cleanup runs on timeout and cancellation; Web/Electron smoke tests remain green.

## Phase 2: measurable AI planning

**Goal:** make one-sentence planning useful without allowing unverified model output to become an unsafe command.

- Create a fixed Web/Electron benchmark with known workflows and seeded defects.
- Measure plan validity, workflow coverage, assertion quality, false passes and model cost.
- Add a review gate for write actions and report planner uncertainty.
- Keep all model output constrained to Charter and typed Capability schemas.
- Make `quick`, `core` and `release` profiles change the generated task graph, negative-path set, surface matrix and evidence gate; preserve the resolved level in every result.

**Gate:** publish benchmark results and refuse a green verdict when the generated plan has no independent business proof. Missing level-specific evidence is `inconclusive`, with the first missing boundary recorded.

## Phase 3: AIHR business vertical

**Goal:** prove value on the resume acquisition workflow.

- Implement project-local test data setup and cleanup in an isolated test workspace.
- Observe file creation, extraction, candidate identity, job binding, assessment terminal state and billing scope.
- Correlate ProofKit `runId`, request IDs and opaque domain IDs.
- Run the same Charter through Web and Electron and compare terminal business facts.

**Gate:** seeded defects in upload, extraction, identity, relation and billing are found with linked evidence; retries do not create duplicate billable facts.

The default AIHR development request is `core`. A resume acquisition run must include at least one surface assertion and one independent business Oracle for its terminal state. `release` additionally compares the Web and Electron paths and executes the configured negative and retry cases.

## Phase 4: failure diagnosis and repair loop

**Goal:** turn evidence into an actionable engineering result.

- Build a first-failure record that joins UI, network, console, process and Oracle events.
- Map the failure to a likely owner, service and source location when repository evidence supports it.
- Generate a repair proposal that cites the observed evidence.
- Re-run the affected charter after a code change and compare before/after evidence.

**Gate:** seeded defects have a correct failure boundary and a repair suggestion that is rejected when evidence is insufficient.

## Phase 5: mobile and protocol extensions

**Goal:** add mobile coverage without changing the Run, Evidence or Verdict contracts.

- Maestro adapter for common Android/iOS/Web accessibility flows.
- Appium adapter for native and hybrid cases Maestro cannot cover.
- Keploy-style traffic fixtures for deterministic asynchronous backend setup.

**Gate:** one business Charter runs on Web, Electron and a mobile adapter with surface-specific actions but the same business Oracle contract.

## Phase 6: team and CI operations

**Goal:** make the local runner useful in continuous delivery.

- GitHub Action and machine-readable result contract.
- Retry and flake classification based on repeated evidence, not blind reruns.
- Parallel run isolation and retention policies.
- Optional result aggregation; no hosted service required for the core product.

**Release rule:** ProofKit must report coverage gaps, blocked prerequisites and inconclusive business observations explicitly. "Whole project tested" is not a valid claim without measured workflow coverage and seeded-defect evidence.
