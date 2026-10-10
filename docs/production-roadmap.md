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
- Expose shared CLI/MCP Web/Electron environment observations before surface attachment: one total deadline, at most eight health endpoints, local source association and a hashed external-workspace artifact. Keep login, fixtures, integration preflight, business terminal state and coverage explicitly unchecked; do not start applications or invoke connector operations.
- Reuse the existing Runner for configurable visible-text prerequisites before surface inspection, return observed/unverified readiness and bounded runtime diagnostics, and propagate MCP cancellation. Readiness is an observation, never business acceptance; trusted integration lifecycle hooks still apply.

- Propagate Mission cancellation and deadlines to primary, replay and negative
  Runs, retain cancelled Run evidence, and wait up to 10 seconds for cleanup.
  Record an explicit environment Finding when a tool does not settle.
- Abort local startup health requests and polling when the Run signal stops.
- Wait up to five seconds for in-flight setup, adapter connection or event
  subscription to return a cleanup handle; mark an expired wait as a possible
  active-resource risk and attempt to release any handle that arrives later.
- Treat adapter, process and integration cleanup failures as non-green results.
- Register scoped integration resources before surface execution, retain each
  acquired handle through later setup failures, and release in reverse order
  under an independent bounded cleanup signal. Verify removal with fresh scoped
  readback and a hashed artifact; check that proof again for primary, replay,
  expected-negative outcomes and repair comparisons. Preserve legacy hooks as
  completed rather than independently verified. Connector-owned rollback before
  handle return remains required. The registered-resource journal now supports
  fail-closed recovery after process termination through `inspect_run_resources`
  and `recover_run_resources`; recovery requires the original connector name and
  explicit version, a versioned hook, the same Run lease, operator/workspace
  write policy, and intact event/artifact provenance. Recovery evidence is
  separate from the original Run verdict.
- Keep Agent tool failures as suspected test findings until an independent product oracle confirms a defect.
- Save contemporaneous snapshot/screenshot evidence for each page assertion and leave a result inconclusive when neither observation can be saved. Failure analysis no longer borrows an earlier step artifact to confirm an assertion defect.
- Classify selected browser runtime signals with evidence links and explicit `record`, `fail` or `ignore` policy; reject invalid URL filters instead of silently widening the monitored scope.
- Select a unique CDP application page for Web/Electron attachment; reject ambiguous windows instead of running a Charter in an arbitrary renderer.
- Inspect Windows loopback listeners before Web/Electron actions and block an evidenced different Git checkout by default. Retain matching or unverified process-path status in Run/Mission evidence without claiming served-byte attestation.
- Run an integration preflight before project setup, adapter connection or write capabilities. A failed preflight is `blocked` with a sanitized `preflight.json` artifact.
- Resolve `fill` environment references only at action execution, retain names rather than values in Mission/Run evidence, and block missing variables before adapter connection. Literal fixture values remain an explicit persisted input.
- Persist task attempts and recover interrupted read-only tasks; block interrupted side-effecting tasks for review instead of replaying them blindly.
- Claim an OS-owned per-Mission execution endpoint before approval or recovery, join a live owner from another CLI/MCP process, route remote cancellation, and release ownership automatically on process exit.
- Never let a rejected Mission promise leave a durable mission in an unexplained running state.

**Gate:** a fixture integration is loaded without a hosted service; a slow run produces a `cancelled` verdict; cleanup runs on timeout and cancellation; an interrupted read-only task resumes with an audited attempt; an interrupted write task is blocked; two independent processes do not execute one Mission twice and remote cancellation reaches its owner; a failed integration preflight prevents adapter connection and writes evidence; a forced-kill Web and Electron run refuses active recovery, then recovers only the orphaned registered resources with unchanged original evidence and preserved sentinel data; Web/Electron smoke tests remain green.

**Live environment observation (2026-10-10):** the existing AIHR workspace was bound to one checkout while its configured resume micro-app on port 5174 was served by another. The shared environment command returned `blocked` despite HTTP 200, saved a hashed source-association artifact, and left both complete before/after source fingerprints unchanged. This confirms the wrong-checkout guard on a real local process; it proves no login, isolated data or business acceptance. The running checkout's local-development documentation also declares shared backend data, so business writes require an explicitly scoped synthetic workspace and cleanup before acceptance.

**Readiness evidence (2026-10-10):** the real Chrome/Electron inspection fixture
waits for delayed controls, rejects a missing prerequisite, retains bounded
redacted runtime diagnostics, and verifies cancellation and external-source
immutability. Two read-only observations of the running AIHR checkout both
observed the configured login text and five controls, with unchanged complete
source fingerprints. Both retained suspected console 404 signals; these do
not identify a failing business workflow or prove a product defect. Evidence
is saved in the local external workspace's `live-readiness-validation.json`.

**Lifecycle evidence (2026-10-10):** real Chrome and Electron CDP, loopback
HTTP provisioning/deletion/readback and the MCP path execute 13 Missions and
22 Runs. This covers a six-Run release matrix plus each surface's successful
cleanup, retained resource, foreign scope, missing readback, negative-only
cleanup failure and timeout. Actual artifact digests, Run IDs and release
timestamps are checked; unexecuted downstream slots retain a missing-run
explanation. The complete minimal source tree remains unchanged and all
configuration, connector code and evidence stay in an external workspace.
`lifecycle-validation.json` indexes each case and its Mission report. This is
isolated fixture evidence, not live AIHR acceptance.

**Forced-exit recovery evidence (2026-10-10):** `tests/resource-recovery-smoke.mjs`
uses real Chrome and Electron processes, kills each child after a registered
resource is created, refuses recovery while the owner is still active, and then
recovers through the MCP/CLI paths after termination. Both surfaces returned
`verified` cleanup with separate recovery artifacts; the original Run evidence
was byte-unchanged, its incomplete original verdict remained unchanged, the
source tree stayed unchanged, and a protected sentinel resource survived. A
concurrent recovery attempt was rejected while a cleanup handle was active.
This proves the registered-resource crash-recovery contract in an isolated
fixture; it does not prove power-loss durability or live AIHR cleanup.

## Phase 2: measurable AI planning

**Goal:** make one-sentence planning useful without allowing unverified model output to become an unsafe command.

- Create a fixed Web/Electron benchmark with known workflows and seeded defects.
- Use the bounded project test map to measure candidate entry-point and route coverage; partial scans must remain visible through the `truncated` flag. Static Web and method-qualified API route measurement is implemented for explicit release suites; entry-point execution evidence remains open.
- Register known business Charters by explicit aliases so one-sentence Agent requests reuse verified workflows; stop automatic execution when a required assertion or Oracle is missing.
- Deliver a portable `proofkit-test` Skill through `agent setup`, with external native Codex/Claude MCP configuration and optional personal installation. The Skill preserves requested scope and level, requires independent business checks and follows the same Mission through evidence and replay. Generated setup explicitly remains unconnected; generic discovery is host-specific. Actual host adherence remains unverified.
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
- Separate test intensity from acceptance scope. New `declared` plans can accept evidenced scenarios on a partial map; `planning.coverage` keeps static and business coverage limits visible. Whole-project requests retain a `project-workflow-coverage` acceptance gate through catalog selection, suite aggregation and replay. A versioned external workflow inventory, source/linkage diagnostics, bounded route/entry candidate review, and declared Charter × surface execution measurement are implemented. A structurally ready project suite can execute while acceptance gaps remain visible. Authenticated completeness review and whole-project acceptance remain open.
- Build a project Mission graph directly from the frozen inventory, including different Charter sets per surface and `core` intensity. This is implemented for fresh, structurally linked inventories; each declared pair is checked against scheduled tasks and saved Run evidence, while source and cleanup gates remain active. Catalog release suites retain their full-matrix rule. `quick` project graph generation, authenticated completeness review and project acceptance remain open.
- Run the same evaluator against deterministic and OpenAI-compatible providers. The evaluator checks level selection, required and forbidden action kinds, required Oracles, assertions and explicitly required negative cases without starting a browser, process or capability.

**Current evidence:** `pnpm benchmark:planner` runs three fixed quick/core/release planning cases through `deterministic-v1`; all three currently pass with a 1.0 pass rate and average score. The same command accepts `PROOFKIT_PLANNER_PROVIDER=openai-compatible`, `PROOFKIT_PLANNER_BASE_URL` and `PROOFKIT_PLANNER_MODEL` for a real model. A workspace-owned Charter catalog and MCP readiness gate now reuse configured business scenarios without guessing assertions. The benchmark measures Charter structure only; it does not prove AIHR business execution.

The host benchmark now separates executable plumbing from agent behavior.
`node tests/host-evaluation-baseline.mjs` passed six synthetic cases through
the generated native stdio MCP launcher and real Chrome: core pass, seeded
business-relation defect, pending business state, project-coverage gap, quick
page check and inline Charter. Its verifier checks Mission/Run facts, report
and hashed evidence under an external workspace, with the source unchanged.
Two optional cases passed through a separately launched Electron/CDP process
using the same generated MCP connection; they distinguish a successful core
run from a seeded business-relation defect and reject a silent Web fallback.
The first real Codex attempt recognized the Skill but did not complete a
ProofKit tool call; the configured provider returned insufficient balance and
the host cancelled MCP calls. The benchmark now stops on that infrastructure
blocker and leaves later cases unrun. It has not measured Codex adherence,
implicit activation, false-pass rate or model cost on a completed Mission.
On 2026-10-10, an implicit-Skill `quick-pass` retry with an isolated writable
test workspace reached its 90-second host deadline while the host command to
read the generated Skill remained in progress. It made no MCP call and saved
no Mission. The evaluator wrote `host-evaluation.json` and terminated after a
bounded pipe drain even when a descendant held stdout open. This is an
incomplete host run, not a ProofKit product verdict; the writable sandbox
change has not yet established successful host execution.

The MCP `await_test_result` tool now waits up to 30 seconds on the saved Mission
without starting or cancelling it. It returns a compact terminal summary and
current evidence integrity, a still-running receipt, or a no-owner action. The
portable Skill uses this path so the host does not have to infer completion from
repeated full Mission reads. MCP unit tests and all six scripted real-Chrome
host cases exercise it, including pass, seeded defect, pending business state,
project coverage gap, quick level and inline Charter; model adherence remains
unverified.

The planning quality gate is covered by tests for missing structural proof, partial discovery versus declared acceptance, whole-project requests, legacy gates, replay and model-reported high confidence. It is a deterministic readiness signal, not a calibrated probability or a substitute for real surface and business evidence. Curated release suites retain their reviewed declared-case scope; the missing-negative-case gap applies to generated release Charters. The real Web/Electron fixture also verifies submitted core scenarios with more than 200 static routes, independent HTTP business facts and a whole-project readiness gate. These checks do not constitute live AIHR acceptance or a measured whole-project workflow inventory.

The explicit release suite now snapshots multiple Charter IDs and its excluded catalog scope into one Mission. A two-workflow Web/Electron smoke drives the real MCP `run_test` path, performs eight primary/replay Runs per Mission, checks independent HTTP business facts, and detects a seeded resume-only defect while the other workflow stays green. This proves the configured suite slice, not automatic whole-project coverage or a live AIHR deployment.

The same real Web/Electron smoke now initializes a Git-bound workflow inventory and calls MCP `run_test` without a suite ID. The generated project Mission executes only `resume/web` and `login/electron`, replays those two pairs at `release`, verifies independent HTTP business facts and reports 2/2 declared checks with a matching source fingerprint. The final verdict remains `inconclusive` because inventory completeness is not independently established. A separate `core` project integration test confirms the same platform-specific graph without replay.

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

The two AIHR wait capabilities now share a deadline across interval waits, gateway requests and response bodies. Loopback HTTP regressions exercise stalled headers/bodies and a stalled partial observation after a complete pending round; timeout retains only complete facts and stays inconclusive. Cancellation preserves the caller's reason, and repeated pending-to-success tests verify timer/listener cleanup. This strengthens connector waiting behavior; live AIHR business acceptance remains open.

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

**Current-submission identity evidence:** `pnpm test:smoke:response` exercises
real Web/Electron multipart submissions, MCP core/release execution and fresh
response IDs on replay. It preloads an older successful object, then requires
the independent reader to identify the newly returned object. A release
Mission contains six Runs with distinct response IDs. The fixture also proves
stored bytes and candidate/job relations through a trusted workspace connector,
detects corrupted server bytes, and verifies restored behavior by direct replay.
Duplicate/no-match requests, pending status and stalled bodies remain
inconclusive; a wrong independent identity fails despite a completed status.
Small chunked/compressed responses pass. Capture artifacts omit unselected
response fields, and the source fixture is unchanged. This validates transport,
identity, evidence and comparison, not live AIHR parsing or worker behavior.

The actual AIHR manual-candidate intake POST returns file/candidate/version/job
and relation identities and can create business objects before a later enqueue
failure. Its workspace-owned `aihr.manualCandidateIntake` Oracle now follows
those captured identities through the existing five readers, verifies file
and version digests, and requires parsing plus assessment/task success. It
does not require an online workflow or invent a client-item idempotency key.
Missing reader identities, worker retries, gateway gaps and superseded current
state remain inconclusive. Same-SHA version ID reuse can legally change the
version's file, so that observation cannot confirm a product defect. The
28-Mission real Chrome/Electron fixture smoke copies the actual connector,
rejects three seeded digest/relation defects, verifies six direct repair
replays and checks source immutability. A live isolated UI Charter, real worker
acceptance, billing and cleanup remain open; non-atomic latest-state readers
cannot prove historical terminal state or concurrent business causality.

## Phase 4: failure diagnosis and repair loop

**Goal:** turn evidence into an actionable engineering result.

- Build a first-failure record that joins UI, network, console, process and Oracle events.
- Map the failure to a likely owner, service and source location when repository evidence supports it.
- Generate a repair proposal that cites the observed evidence.
- Re-run the affected charter after a code change and compare before/after evidence.

**Current evidence:** direct Mission replay provenance and a read-only `MissionComparison` now pair saved Run scope and independent business source artifacts. AIHR loopback Web/Electron smokes and a two-workflow release suite inject a business defect, restore the fixture, replay through MCP, and receive `verified-in-scope`; missing facts, changed scope and incomplete negative/replay slots are inconclusive. This demonstrates test-scope repair verification against fixtures, not causal proof of a source edit or live AIHR remediation. Source-location diagnosis and validated repair proposals still need broader seeded-defect and real-workspace evidence.

Real Chrome and Electron smoke cases now make a visible page assertion fail, then confirm the Finding only from the failed assertion's own saved snapshot. The release suite checks that all eight primary/replay Runs link their assertion-time snapshots through the Run report. Missing assertion observation stays inconclusive; these fixtures do not prove that every assertion or source-location hint is semantically correct.

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

The installed-package smoke also generates Codex/Claude native onboarding
artifacts, installs and reuses the portable Skill in an isolated personal
directory, and connects via the emitted JSON MCP launcher configuration.
The CLI optionally checks that emitted launcher with `agent setup
--check-connection`: it lists required tools and verifies the project/workspace
binding through `inspect_test_scope`, without creating a Mission or Run.
Explicit `--register-host` then installs the Skill and invokes the Codex or
Claude Code CLI only after the local check passes; an existing name is left
untouched. The installed-package smoke exercises this path with an isolated
host CLI, and a real Codex CLI run wrote only to an isolated `CODEX_HOME`.
Neither proves Skill discovery or model behavior; connector registration
code is still trusted and loaded on server startup.
Source files remain unchanged and no Mission/Run is started by setup. This
checks artifact delivery and stdio interoperability, not automatic discovery
inside either host or effectiveness of natural-language testing.

**Release rule:** ProofKit must report coverage gaps, blocked prerequisites and inconclusive business observations explicitly. "Whole project tested" is not a valid claim without measured workflow coverage and seeded-defect evidence.
