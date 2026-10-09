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
- Persist task attempts and recover interrupted read-only tasks; block interrupted side-effecting tasks for review instead of replaying them blindly.
- Never let a rejected Mission promise leave a durable mission in an unexplained running state.

**Gate:** a fixture integration is loaded without a hosted service; a slow run produces a `cancelled` verdict; cleanup runs on timeout and cancellation; an interrupted read-only task resumes with an audited attempt; an interrupted write task is blocked; Web/Electron smoke tests remain green.

## Phase 2: measurable AI planning

**Goal:** make one-sentence planning useful without allowing unverified model output to become an unsafe command.

- Create a fixed Web/Electron benchmark with known workflows and seeded defects.
- Measure plan validity, workflow coverage, assertion quality, false passes and model cost.
- Add a review gate for write actions and report planner uncertainty.
- Keep all model output constrained to Charter and typed Capability schemas.
- Measure generated Charter and Mission quality, and preserve the resolved level in every result. The kernel already changes the task graph, surface matrix, replay obligations, explicit negative-case tasks and evidence gate for `quick`, `core` and `release`.
- Run the same evaluator against deterministic and OpenAI-compatible providers. The evaluator checks level selection, required and forbidden action kinds, required Oracles, assertions and explicitly required negative cases without starting a browser, process or capability.

**Current evidence:** `pnpm benchmark:planner` runs three fixed quick/core/release planning cases through `deterministic-v1`; all three currently pass with a 1.0 pass rate and average score. The same command accepts `PROOFKIT_PLANNER_PROVIDER=openai-compatible`, `PROOFKIT_PLANNER_BASE_URL` and `PROOFKIT_PLANNER_MODEL` for a real model. The benchmark measures Charter structure only; it does not prove AIHR business execution.

**Gate:** publish benchmark results for every enabled planner and refuse a green verdict when the generated plan has no independent business proof. Missing level-specific evidence, a required release surface, or a required replay is `inconclusive`, with the first missing boundary recorded.

## Phase 3: AIHR business vertical

**Goal:** prove value on the resume acquisition workflow.

- Run the project-local ordinary upload integration and scoped fixture in an isolated test workspace.
- Run the checked-in ordinary upload Charter through the real Web and Electron adapters against a loopback gateway fixture.
- Seed a stale candidate-to-job resume binding and require the Oracle artifact to produce a confirmed product Finding, Diagnosis and RepairSuggestion.
- Observe file creation, extraction, candidate identity, job binding, assessment terminal state and billing scope.
- Correlate ProofKit `runId`, request IDs and opaque domain IDs.
- Run the same Charter through Web and Electron, replay both runs, and compare terminal business facts.

**Current evidence:** the isolated Web/Electron smoke proves upload binding, terminal extraction, candidate identity, job relation, assessment state and workflow usage, and detects the seeded stale relation with linked evidence. A real isolated AIHR workspace, billing assertions and retry/idempotency checks remain required before this phase is complete.

**Gate:** seeded defects in upload, extraction, identity, relation and billing are found with linked evidence; retries do not create duplicate billable facts.

The default AIHR development request is `core`. The ordinary PDF upload Charter is the default business path; the online intake Charter remains a compatibility flow. A resume acquisition run must include at least one surface assertion and one independent business Oracle for its terminal state. `release` compares and replays the Web and Electron paths; explicitly configured negative or recovery cases are also executed and included in the evidence gate.

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
