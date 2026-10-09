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
- Enforce a separate Mission deadline across reconnaissance, surface runs,
  recovery and final verification, with a persisted timeout Finding.
- Expose cancellation through the CLI and MCP.
- Propagate Mission cancellation and deadlines to primary, replay and negative
  Runs, retain cancelled Run evidence, and wait up to 10 seconds for cleanup.
  Record an explicit environment Finding when a tool does not settle.
- Abort local startup health requests and polling when the Run signal stops.
- Wait up to five seconds for in-flight setup, adapter connection or event
  subscription to return a cleanup handle; mark an expired wait as a possible
  active-resource risk and attempt to release any handle that arrives later.
- Treat adapter, process and integration cleanup failures as non-green results.
- Keep Agent tool failures as suspected test findings until an independent product oracle confirms a defect.
- Classify selected browser runtime signals with evidence links and explicit `record`, `fail` or `ignore` policy; reject invalid URL filters instead of silently widening the monitored scope.
- Select a unique CDP application page for Web/Electron attachment; reject ambiguous windows instead of running a Charter in an arbitrary renderer.
- Inspect Windows loopback listeners before Web/Electron actions and block an evidenced different Git checkout by default. Retain matching or unverified process-path status in Run/Mission evidence without claiming served-byte attestation.
- Run an integration preflight before project setup, adapter connection or write capabilities. A failed preflight is `blocked` with a sanitized `preflight.json` artifact.
- Resolve `fill` environment references only at action execution, retain names rather than values in Mission/Run evidence, and block missing variables before adapter connection. Literal fixture values remain an explicit persisted input.
- Persist task attempts and recover interrupted read-only tasks; block interrupted side-effecting tasks for review instead of replaying them blindly.
- Claim an OS-owned per-Mission execution endpoint before approval or recovery, join a live owner from another CLI/MCP process, route remote cancellation, and release ownership automatically on process exit.
- Never let a rejected Mission promise leave a durable mission in an unexplained running state.

**Gate:** a fixture integration is loaded without a hosted service; a slow run produces a `cancelled` verdict; cleanup runs on timeout and cancellation; an interrupted read-only task resumes with an audited attempt; an interrupted write task is blocked; two independent processes do not execute one Mission twice and remote cancellation reaches its owner; a failed integration preflight prevents adapter connection and writes evidence; Web/Electron smoke tests remain green.

## Phase 2: measurable AI planning

**Goal:** make one-sentence planning useful without allowing unverified model output to become an unsafe command.

- Create a fixed Web/Electron benchmark with known workflows and seeded defects.
- Use the bounded project test map to measure candidate entry-point and route coverage; partial scans must remain visible through the `truncated` flag. Static Web and method-qualified API route measurement is implemented for explicit release suites; entry-point execution evidence remains open.
- Register known business Charters by explicit aliases so one-sentence Agent requests reuse verified workflows; stop automatic execution when a required assertion or Oracle is missing.
- Let a host coding agent submit a structured Charter directly to `run_test` or `create_test_mission` when no catalog entry exists; recompute planning gaps and validate registered operations, origin and side-effect policy before Mission persistence. CLI Mission creation also accepts a workspace-owned Charter file.
- Give host agents a read-only `inspect_surface` entry point before Charter authoring. It uses the ordinary Run evidence lifecycle, returns bounded Web/Electron control hints with unique observed selectors, and explicitly reports no product verdict; real Web and Electron smoke tests exercise those hints.
- Give host agents `inspect_test_scope`/CLI `scope` to join source locations, compatible saved-plan checks and registered business capability/Oracle hints without executing a test. Shared route reconciliation keeps static mapping semantics aligned with release suites. Literal focus, output omission and truncated inventory stay explicit; this does not infer whole-project workflow coverage or evaluate runtime readiness.
- Compose static Gin group prefixes within a source file and retain source/method evidence. Unresolved helper prefixes, dynamic paths and unsupported registration operations are diagnostic locations rather than guessed routes. Cross-function propagation and other framework-specific composition remain open.
- Prioritize literal module/source focus and eligible Charter alias targets before bounded route/entry retention. File-path focus guides capped Git candidates and discovered filesystem paths; matching Gin diagnostic details remain visible. A read-only AIHR audit retained all 25 resume-collection router declarations after a global map had retained none, with unchanged source fingerprints. This proves the focused static slice, not business execution or complete project coverage.
- Extend the explicit multi-Charter release suite with measured project-map coverage. It now snapshots reviewed route-to-Charter declarations, reports absent or ambiguous mappings, and counts Web paths or matching 2xx API responses as observed only after passing primary and replay runs on every required surface. Registered release Charters outside the suite and unmapped static routes remain visible gaps.
- Measure plan validity, workflow coverage, assertion quality, false passes and model cost.
- Add a review gate for write actions and report planner uncertainty.
- Keep all model output constrained to Charter and typed Capability schemas.
- Measure generated Charter and Mission quality, and preserve the resolved level in every result. The kernel already changes the task graph, surface matrix, replay obligations, explicit negative-case tasks and evidence gate for `quick`, `core` and `release`.
- Persist `PlanningQuality` with generated Charters and Mission plans. Recompute its evidence gaps from validated assertions, required Oracles, release negative cases and the bounded Project Map; expose it to MCP callers and keep a known planning gap from producing a green Mission.
- Separate test intensity from acceptance scope. New `declared` plans can accept evidenced scenarios on a partial map; `planning.coverage` keeps static and business coverage limits visible. Whole-project requests retain a `project-workflow-coverage` execution gate through catalog selection, suite aggregation and replay. A complete workflow inventory and measurable project acceptance remain open.
- Run the same evaluator against deterministic and OpenAI-compatible providers. The evaluator checks level selection, required and forbidden action kinds, required Oracles, assertions and explicitly required negative cases without starting a browser, process or capability.

**Current evidence:** `pnpm benchmark:planner` runs three fixed quick/core/release planning cases through `deterministic-v1`; all three currently pass with a 1.0 pass rate and average score. The same command accepts `PROOFKIT_PLANNER_PROVIDER=openai-compatible`, `PROOFKIT_PLANNER_BASE_URL` and `PROOFKIT_PLANNER_MODEL` for a real model. A workspace-owned Charter catalog and MCP readiness gate now reuse configured business scenarios without guessing assertions. The benchmark measures Charter structure only; it does not prove AIHR business execution.

The planning quality gate is covered by tests for missing structural proof, partial discovery versus declared acceptance, whole-project requests, legacy gates, replay and model-reported high confidence. It is a deterministic readiness signal, not a calibrated probability or a substitute for real surface and business evidence. Curated release suites retain their reviewed declared-case scope; the missing-negative-case gap applies to generated release Charters. The real Web/Electron fixture also verifies submitted core scenarios with more than 200 static routes, independent HTTP business facts and a whole-project readiness gate. These checks do not constitute live AIHR acceptance or a measured whole-project workflow inventory.

The explicit release suite now snapshots multiple Charter IDs and its excluded catalog scope into one Mission. A two-workflow Web/Electron smoke drives the real MCP `run_test` path, performs eight primary/replay Runs per Mission, checks independent HTTP business facts, and detects a seeded resume-only defect while the other workflow stays green. This proves the configured suite slice, not automatic whole-project coverage or a live AIHR deployment.

**Gate:** publish benchmark results for every enabled planner and refuse a green verdict when the generated plan has no independent business proof. Missing level-specific evidence, a required release surface, or a required replay is `inconclusive`, with the first missing boundary recorded.

## Phase 3: AIHR business vertical

**Goal:** prove value on the resume acquisition workflow.

- Run the project-local ordinary upload integration and scoped fixture in an isolated test workspace.
- Run the checked-in ordinary upload Charter through the real Web and Electron adapters against a loopback gateway fixture.
- Seed a stale candidate-to-job resume binding and require the Oracle artifact to produce a confirmed product Finding, Diagnosis and RepairSuggestion.
- Observe file creation, extraction, candidate identity, job binding, assessment terminal state and billing scope.
- Correlate ProofKit `runId`, request IDs and opaque domain IDs.
- Execute an explicit duplicate-upload negative case and require the connector Oracle to prove the same scoped `client_item_key` reuses the same file identity and digest.
- Run the same Charter through Web and Electron, replay both runs, and compare terminal business facts.

**Current evidence:** the isolated Web/Electron smoke proves upload binding, terminal extraction, candidate identity, job relation, assessment state and workflow usage, detects the seeded stale relation with linked evidence, and runs a duplicate-upload negative case whose Oracle proves duplicate reuse. A fixture-specific core Charter is selected from the external catalog by the one-sentence MCP request “测试简历获取” with no explicit level; both surfaces pass the success path, return business evidence and reject the seeded defect through `run_test`, `get_mission_status` and `get_mission_evidence`. The ordinary-upload reference Charter still needs a real surface assertion before catalog registration. A real isolated AIHR workspace, billing assertions and worker retry checks remain required before this phase is complete.

The reference connector now requires evaluation and worker task success together, exact file/job/candidate identities, and a concrete assessment ID. Isolated HTTP regressions cover pending/retrying/missing facts, explicit worker failures, wrong identities and retry recovery. Online acceptance records its stage scope, requires a screening-reject relation for workflow termination, and becomes inconclusive after an attachment binding or completed workflow supersedes the current-file facts. Saved Run business artifacts distinguish pending or superseded scope from an evidenced wrong-file failure; unverified results produce no product diagnosis or repair suggestion. These are connector/Runner regressions with mocked surface connection, not live AIHR UI acceptance. Concurrent attachment progress before its workflow identity is visible, historical phase evidence, and attachment/lifecycle Charters remain open.

**Gate:** seeded defects in upload, extraction, identity, relation and billing are found with linked evidence; retries do not create duplicate billable facts.

**File-input evidence:** `pnpm test:smoke:upload` now runs real hidden file
inputs in Chrome and an isolated Electron renderer, real multipart requests,
and independent server facts. Set `PROOFKIT_ELECTRON_PATH` to an installed
Electron executable; `PROOFKIT_BROWSER_PATH` optionally selects Chromium.
The smoke creates its own app and test profile. A release Mission executes six Runs across both
surfaces (primary, replay and invalid-file negative case). The fixture checks
ordered multi-file bytes, Chinese filenames and hashes, detects a UI-success /
wrong-server-bytes defect, and verifies the restored fixture by direct replay.
Changed or missing fixtures block file selection and prevent repair
certification. Ambiguous selectors and non-file controls fail without product
findings or uploads. Upload evidence omits input content and the source tree
remains unchanged. This validates the transport and evidence contract; live
AIHR parsing, platform acquisition, billing and worker retries remain open.

The default AIHR development request is `core`. The ordinary PDF upload Charter is the default business path; the online intake Charter remains a compatibility flow. A resume acquisition run must include at least one surface assertion and one independent business Oracle for its terminal state. `release` compares and replays the Web and Electron paths; explicitly configured negative or recovery cases are also executed and included in the evidence gate.

## Phase 4: failure diagnosis and repair loop

**Goal:** turn evidence into an actionable engineering result.

- Build a first-failure record that joins UI, network, console, process and Oracle events.
- Map the failure to a likely owner, service and source location when repository evidence supports it.
- Generate a repair proposal that cites the observed evidence.
- Re-run the affected charter after a code change and compare before/after evidence.

**Current evidence:** direct Mission replay provenance and a read-only `MissionComparison` now pair saved Run scope and independent business source artifacts. AIHR loopback Web/Electron smokes and a two-workflow release suite inject a business defect, restore the fixture, replay through MCP, and receive `verified-in-scope`; missing facts, changed scope and incomplete negative/replay slots are inconclusive. This demonstrates test-scope repair verification against fixtures, not causal proof of a source edit or live AIHR remediation. Source-location diagnosis and validated repair proposals still need broader seeded-defect and real-workspace evidence.

Mission discovery and final verification now record bounded Git source fingerprints. A comparison shows whether the source changed between runs and refuses repair verification when the candidate source changed during its own run. The current AIHR checkout is capturable without copying its diff or file contents into evidence. Live AIHR execution remains pending until an isolated gateway, CDP session, test credentials and fixture are available.

The Windows loopback target check now records a listener's Git checkout before surface actions and blocks a different checkout by default. Repair comparison becomes inconclusive when only one side has target association evidence, target origins differ, or either listener is associated with another checkout. This still does not attest served bytes or detect a listener replacement between checks.

Mission evidence now includes a bounded result projection and a static HTML/JSON snapshot in the external workspace. The report preserves the saved verdict, scope limits, missing execution slots, raw versus expected negative outcomes, the first failure and direct replay comparison. Report generation checks local evidence containment and available SHA-256 digests; missing or changed artifacts remain unavailable without rewriting the acceptance result. The release-suite smoke opens real Web/Electron fixture results in Chrome, checks wide and narrow layouts, follows a Run evidence link, verifies the CLI report command, and compares the good, seeded-defect and repaired-fixture Missions. This verifies report delivery and fixture-scoped repair evidence, not live AIHR acceptance or proof that an application source edit caused the repair.

**Gate:** seeded defects have a correct failure boundary and a repair suggestion that is rejected when evidence is insufficient.

## Phase 5: mobile and protocol extensions — adapter slice complete

**Goal:** add mobile coverage without changing the Run, Evidence or Verdict contracts.

- W3C WebDriver/Appium adapter for common Android/iOS/native and hybrid flows.
- Keep Maestro or device-cloud provisioning as separate adapters so the local Runner does not own device lifecycle.
- Keploy-style traffic fixtures for deterministic asynchronous backend setup.

**Current evidence:** `@proofkit/adapters` has a tested W3C WebDriver mobile adapter, and the contracts, Local Runner, CLI and MCP accept `mobile` as a surface. The test uses a fake driver protocol; an emulator-backed business run remains required.

**Gate:** one business Charter runs on Web, Electron and a real mobile adapter with surface-specific actions but the same business Oracle contract.

## Phase 6: team and CI operations

**Goal:** make the local runner useful in continuous delivery.

- GitHub Action and machine-readable result contract.
- Retry and flake classification based on repeated evidence, not blind reruns.
- Parallel run isolation and retention policies.
- Optional result aggregation; no hosted service required for the core product.

**Current distribution evidence:** `pnpm test:distribution` builds one `proofkit-ai` tarball, installs it in a fresh directory without the repository's `node_modules`, runs CLI onboarding, and calls the installed MCP server over stdio. The internal `@proofkit/*` modules are bundled into the two entrypoints. npm publication and cross-platform release verification remain open.

**Release rule:** ProofKit must report coverage gaps, blocked prerequisites and inconclusive business observations explicitly. "Whole project tested" is not a valid claim without measured workflow coverage and seeded-defect evidence.
