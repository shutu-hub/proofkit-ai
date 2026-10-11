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
- Extend the same read-only environment entry point to mobile WebDriver `/status`: check a bounded W3C ready value without creating a session, keep driver ownership separate from tested-app source ownership, and retain device attachment and business acceptance as unchecked.
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
- Keep one-shot HTTP Oracle transport errors, timeouts, oversized responses and unexpected 401/403/429 reader responses inconclusive. Preserve only bounded status/digest or reason evidence; explicitly expected access-denial statuses remain valid negative checks. A passing UI assertion cannot turn a denied business read green.
- Save contemporaneous snapshot/screenshot evidence for each page assertion and leave a result inconclusive when neither observation can be saved. Failure analysis no longer borrows an earlier step artifact to confirm an assertion defect.
- Classify selected browser runtime signals with evidence links and explicit `record`, `fail` or `ignore` policy; reject invalid URL filters instead of silently widening the monitored scope.
- Select a unique CDP application page for Web/Electron attachment; reject ambiguous windows instead of running a Charter in an arbitrary renderer.
- Inspect Windows and Linux loopback listeners before Web/Electron actions and block an evidenced different Git checkout by default. Retain matching or unverified process-path status in Run/Mission evidence without claiming served-byte attestation. The Linux `/proc` socket-inode path passed a privileged Ubuntu runner smoke; ordinary-user process access still needs broader host validation.
- Associate declared loopback backend health endpoints with their own listener during environment inspection. A Run blocks an already running foreign checkout in preflight, then checks again after project/connector setup and before browser attachment, saving a separate post-setup artifact. Undeclared integration endpoints and listener changes during the Run still require separate association evidence.
- Let trusted connectors inspect the local listeners of endpoints they actually use. The AIHR reference checks `AIHR_PROOFKIT_API_BASE_URL` before and after setup even when no health endpoint is declared; an evidenced foreign checkout blocks by default, while unavailable association remains unverified and `record` policy retains the mismatch.
- Recheck connector endpoint continuity before surface cleanup. The AIHR reference compares its gateway URL and listener identity with the post-setup baseline; a changed or unavailable previously verified listener makes the Run inconclusive, saves a post-run artifact, and prevents an Oracle mismatch from becoming a product diagnosis. Injected listener changes verify the downgrade, while isolated Web/Electron fixtures verify artifact emission. The currently foreign live AIHR gateway blocks before a business Run can exercise this final check.
- Run an integration preflight before project setup, adapter connection or write capabilities. A failed preflight is `blocked` with a sanitized `preflight.json` artifact.
- Resolve `fill` environment references only at action execution, retain names rather than values in Mission/Run evidence, and block missing variables before adapter connection. Literal fixture values remain an explicit persisted input.
- Persist task attempts and recover interrupted read-only tasks only when their recorded tool recovery key still matches; block side-effecting, unversioned or changed tools for review.
- Claim an OS-owned per-Mission execution endpoint before approval or recovery, join a live owner from another CLI/MCP process, route remote cancellation, and release ownership automatically on process exit.
- Claim OS-owned exclusive Run leases for the external test workspace and configured CDP/WebDriver attachment target before setup and surface attachment. Electron port-file attachments lease an existing resolved endpoint before setup, reacquire the final endpoint after setup when it changes, and pin the adapter to it. Block a concurrent Run with saved evidence, and retain leases until normal or late cleanup settles. This serializes Runs that share one workspace or explicit target on a host, including different port files resolving to one endpoint; shared business accounts/backends and cross-host use require their own isolation policy.
- Never let a rejected Mission promise leave a durable mission in an unexplained running state.

**Gate:** a fixture integration is loaded without a hosted service; a slow run produces a `cancelled` verdict; cleanup runs on timeout and cancellation; an interrupted read-only task resumes with an audited attempt; an interrupted write task is blocked; two independent processes do not execute one Mission twice and remote cancellation reaches its owner; a failed integration preflight prevents adapter connection and writes evidence; a forced-kill Web and Electron run refuses active recovery, then recovers only the orphaned registered resources with unchanged original evidence and preserved sentinel data; Web/Electron smoke tests remain green.

**Failure collection evidence (2026-10-11):** a single-Charter `release` Mission now finishes its declared Web/Electron primary and replay Runs after the first evidenced business failure, as an explicit Suite already did. `node tests/release-suite-smoke.mjs` verifies four real Chrome/Electron Runs, a confirmed product Finding, and a failed Mission/report after a transient Web defect. Agent tests also cover declared negative-case scheduling after a primary failure. Environment blocks, cancellation and tool exceptions still stop the Agent Loop.

**Saved execution audit (2026-10-11):** the same Chrome/Electron suite smoke reopens a passed Mission, changes only a replay's source Run ID, duplicates a primary observation, or adds one intact Electron report reference to a Web Run observation. MCP plus `summary.json` downgrade current acceptance to `inconclusive` with a specific slot issue while retaining the historical verdict; the borrowed-evidence case keeps full Mission file integrity `intact`, demonstrating that valid file hashes do not establish Run ownership. Local Runner regressions cover single-Charter replay binding, mismatched negative outcomes and borrowed evidence. The audit uses the full frozen Mission record, so the compact report's 200-row limit does not bypass it; it does not attest against an operator who can rewrite the entire workspace.

**Saved Agent trace audit (2026-10-11):** reopening a Mission now checks the full AgentStep → ToolCall → Observation ownership chain, including task input, attempt number, terminal status and Run evidence identity. Swapping Web/Electron observations, forging a call receipt or detaching a failed Run's observation withdraws the current claim while retaining the saved verdict. Missing legacy receipts are `unverified`; contradictory receipts are `incomplete`. The current claim requires `complete` for both passing acceptance and a saved failure. Web/Electron Mission smokes and the CLI CI gate exercise the same read path; this remains a consistency audit of local records, not an external attestation of tool execution.

**Observed failure Run audit (2026-10-11):** a confirmed product Finding now requires the observed Run matrix and saved Run facts to recheck cleanly before the historical `failed` result remains a current defect claim. A legitimate early failure may leave later declared slots unexecuted, which is counted separately from missing evidence for an attempted task. Tampering only with a failing Mission's Run counts now yields `testVerdict: inconclusive` while the original Finding stays visible. Release-suite regressions cover an observed failure with all slots run and a deferred negative slot. Full AIHR live acceptance remains open.

**Negative outcome continuity (2026-10-11):** a negative or recovery case can certify only a `passed` or `failed` surface outcome. A changed or unverified Web/Electron listener and a failed connector post-run check prevent an otherwise matching negative verdict from passing. The saved execution audit reopens the Run summary and withdraws current acceptance if continuity facts change, while retaining the historical Mission verdict. Unit regressions cover each gap, the legacy `blocked`/`inconclusive` expectations, valid expected rejection, and file replay identity. The real Web/Electron response capture and Windows listener replacement smokes pass; live AIHR business acceptance remains separate.

**Expected failure provenance (2026-10-11):** raw `failed` alone cannot prove a negative case succeeded. Acceptance now requires completed actions, evidenced passing surface assertions, and a declared failing business Oracle whose independent source artifact belongs to that Run. A click error, missing Oracle, failed page assertion, or a runtime failure cannot substitute for the intended rejection. Reopening saved Run facts applies the same rule without rewriting the historical verdict. A positive observed rejection with raw `passed` remains the preferred form.

**Saved Run fact audit (2026-10-11):** new Run summaries persist the actual adapter and replay source. Mission evidence reopening compares those facts, executable Charter contents, verdict, counts and cleanup with each Run observation; a missing legacy execution identity cannot sustain a current pass. Runner and Local Runner regressions cover the persisted fields and wrong adapter/Charter facts. The real Chrome/Electron suite smoke swaps a Web and Electron Run's Mission labels and task receipts while leaving all Run files and hashes intact; the fact audit must reject the false platform claim. This remains local-state consistency checking, not signed attestation of a browser binary or protection against an operator rewriting all evidence.

**Live environment observation (2026-10-10):** the existing AIHR workspace was bound to one checkout while its configured resume micro-app on port 5174 was served by another. The shared environment command returned `blocked` despite HTTP 200, saved a hashed source-association artifact, and left both complete before/after source fingerprints unchanged. This confirms the wrong-checkout guard on a real local process; it proves no login, isolated data or business acceptance. The running checkout's local-development documentation also declares shared backend data, so business writes require an explicitly scoped synthetic workspace and cleanup before acceptance.

**Declared backend ownership (2026-10-11):** with the AIHR source selected and `8080/healthz` declared as a local health endpoint for one read-only check, HTTP returned 200 while the listener resolved to `D:/tmp/aihr-livekit-interview-voice`. Environment inspection `environment-20261011071208-03449c76` marked `health-1` blocked and saved a hashed artifact; Run `20261011071214-bf2b55cd` stopped in preflight with zero page steps and its own evidence. The configured `5274` page was unreachable. This validates the foreign-backend guard on the current machine, not AIHR business acceptance or ownership of undeclared connector URLs.

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

**Durable Agent limits (2026-10-11):** Mission execution now saves its first
start and absolute deadline. A resumed owner cannot reset the total timeout;
expired interrupted read tasks close without retry, and previously saved
AgentStep/ToolCall attempts count against the Mission-wide step limit. Agent
regressions cover approval wait, exact-limit completion, expired current and
legacy Missions, interrupted reads and cumulative steps.
The real Web/Electron release-suite smoke also passed after the schema change;
its partial-inventory fixture now exceeds the scanner's current 2,000-route
retention limit instead of relying on the older 230-route threshold.
MCP start and nonterminal wait receipts now expose bounded task progress and
the saved deadline, so a host can keep waiting through cancellation cleanup
without restarting the Mission or treating progress as a product verdict.
Forced-exit cross-process regressions now verify that the persisted deadline
does not restart and the crashed attempt still consumes the Mission step
budget. Each started ToolCall also records its side-effect declaration and an
optional recovery key. Automatic recovery requires both values, tool name,
Charter ID and input to match the current registration and task. Local Runner
hashes its source/workspace binding, effective configuration, evidence path,
connector name/version and execution restrictions into a versioned key.
Unversioned or directly injected operations omit it. A legacy receipt, changed
key or crashed write attempt whose replacement claims to be read-only remains
blocked. Connector authors must advance versions when behavior or imported code
changes; the declared key does not attest to unchanged tool code.

## Phase 2: measurable AI planning

**Planning guidance update (2026-10-11):** `inspect_test_scope` now returns bounded `planningReadiness` counts and gaps derived from the existing catalog validators. It distinguishes a matching quick Charter from a requested core plan, an omitted compatible plan from no plan, and literal source/reader-name misses from verified absence. A ready release suite is considered even when the focused Charter list is empty. The AIHR external workspace reproduces the core resume-acquisition gap; this is a planning observation, not live business acceptance.

**External Charter discovery (2026-10-11):** scope inspection now scans bounded, non-recursive external Charter directories without registering or executing files. It excludes registered paths and links, returns fixed structural and execution-policy hints, and falls back explicitly when the literal focus misses candidate names. The real AIHR workspace yielded three unregistered core candidates: online and ordinary upload lack positive UI assertions, all three need operator write opt-in, and the MCP boundary additionally requires a workspace policy change before their `allow` scenarios can run. None proves live AIHR readiness or acceptance.

**Pinned candidate execution (2026-10-11):** an agent can now review a valid scope candidate and pass its path and SHA-256 directly to MCP `run_test` or `create_test_mission`; CLI Mission creation exposes the same pair. The shared bounded reader rejects changed, oversized, redirected and non-Charter paths before Mission creation. The ordinary planner and execution policy still gate the frozen Charter. A real MCP fixture ran a quick candidate and then rejected the same path after its bytes changed; this is an isolated contract check, not live AIHR acceptance.

**Goal:** make one-sentence planning useful without allowing unverified model output to become an unsafe command.

- Create a fixed Web/Electron benchmark with known workflows and seeded defects.
- Use the bounded project test map to measure candidate entry-point and route coverage; partial scans must remain visible through the `truncated` flag. Static Web and method-qualified API route measurement is implemented for explicit release suites; entry-point execution evidence remains open.
- Register known business Charters by explicit aliases so one-sentence Agent requests reuse verified workflows; stop automatic execution when a required assertion or Oracle is missing.
- Deliver a portable `proofkit-test` Skill through `agent setup`, with external native Codex/Claude MCP configuration and optional personal installation. The Skill preserves requested scope and level, requires independent business checks and follows the same Mission through evidence and replay. Generated setup explicitly remains unconnected; generic discovery is host-specific. Real Codex adherence is verified on eight isolated cases below, while broader model and project behavior remains unmeasured.
- Let a host coding agent submit a structured Charter directly to `run_test` or `create_test_mission` when no catalog entry exists; recompute planning gaps and validate registered operations, origin and side-effect policy before Mission persistence. CLI Mission creation also accepts a workspace-owned Charter file.
- Let an agent-submitted Charter include a bounded read-only HTTP Oracle for a current captured response ID. Mission/Run validation rejects missing ID bindings, name collisions and non-loopback MCP readers. Isolated Web/Electron smoke verifies terminal success, independent ID mismatch and an expected negative state; live AIHR reader contracts and authentication remain to be validated separately.
- Teach the portable Skill to choose a Charter-local reader when a project exposes a suitable GET terminal API. Four optional no-catalog/no-registered-Oracle Web/Electron fixtures now pass the scripted native-MCP baseline and real Codex implicit-Skill evaluation: the host authors the response-bound reader, passes the current-ID cases and rejects historical-ID responses with business evidence. The evaluator separately checks the actual adapter, captured ID and reader facts; the default Windows sandbox stalled before a tool call, while the documented isolated `unelevated` fallback completed the cases. Live AIHR, Claude Code and cross-project false-pass rates remain open.
- Give host agents a read-only `inspect_surface` entry point before Charter authoring. It uses the ordinary Run evidence lifecycle, returns bounded Web/Electron control hints with unique observed selectors, and explicitly reports no product verdict; real Web and Electron smoke tests exercise those hints.
- Give host agents `inspect_test_scope`/CLI `scope` to join source locations, compatible saved-plan checks and registered business capability/Oracle hints without executing a test. Shared route reconciliation keeps static mapping semantics aligned with release suites. Literal focus, output omission and truncated inventory stay explicit; this does not infer whole-project workflow coverage or evaluate runtime readiness.
- Compose static Gin group prefixes and direct typed-router helper calls within a source file, retaining source/method evidence. A helper expands only when every observed same-file caller has a static prefix and its router parameter is not reassigned or shadowed. Unresolved calls, dynamic paths and unsupported registration operations remain diagnostic locations rather than guessed routes. Cross-file propagation and other framework-specific composition remain open.
- Prioritize literal module/source focus and eligible Charter alias targets before bounded route/entry retention. File-path focus guides capped Git candidates and discovered filesystem paths; matching Gin diagnostic details remain visible. A read-only AIHR audit retained all 25 resume-collection router declarations after a global map had retained none, with unchanged source fingerprints. This proves the focused static slice, not business execution or complete project coverage.
- Extend the explicit multi-Charter release suite with measured project-map coverage. It now snapshots reviewed route-to-Charter declarations, reports absent or ambiguous mappings, and counts Web paths only on the Run's configured HTTP target origin, Electron `file:` hash routes only on the exact configured HTML document with declared-pattern snapshot evidence, or matching 2xx API responses, after passing primary and replay runs on every required surface. Missing target identity and foreign-site or foreign-file paths remain unobserved. Registered release Charters outside the suite and unmapped static routes remain visible gaps.
- Measure plan validity, workflow coverage, assertion quality, false passes and model cost.
- Add a review gate for write actions and report planner uncertainty.
- Keep all model output constrained to Charter and typed Capability schemas.
- Measure generated Charter and Mission quality, and preserve the resolved level in every result. The kernel already changes the task graph, surface matrix, replay obligations, explicit negative-case tasks and evidence gate for `quick`, `core` and `release`.
- Persist `PlanningQuality` with generated Charters and Mission plans. Recompute its evidence gaps from validated assertions, required Oracles, release negative cases and the bounded Project Map; expose it to MCP callers and keep a known planning gap from producing a green Mission.
- Separate test intensity from acceptance scope. New `declared` plans can accept evidenced scenarios on a partial map; `planning.coverage` keeps static and business coverage limits visible. Whole-project requests retain a `project-workflow-coverage` gate unless a new `core`/`release` inventory Mission is admitted against an externally trusted, exclusion-free source review. The admitted Mission still needs exact Charter × surface Runs, business source facts, observed routes, source binding and evidence audits before a pass is limited to **reviewed source workflows**. Semantic completeness remains the reviewer's responsibility; broad production acceptance across real projects remains open.
- Build a project Mission graph directly from the frozen inventory, including different Charter sets per surface and all three intensities. This is implemented for fresh, structurally linked inventories; each declared pair is checked against scheduled tasks and saved Run evidence, while source and cleanup gates remain active. `quick` requires a positive surface assertion and evidence but does not claim a business terminal state or API business route observation. Catalog release suites retain their full-matrix rule. A real-browser isolated smoke now verifies admitted core acceptance and re-audit failures on route loss, business evidence change, trust revocation and non-retroactive admission; real AIHR and broad-project acceptance remain open.
- Run the same evaluator against deterministic and OpenAI-compatible providers. The evaluator checks level selection, required and forbidden action kinds, required Oracles, assertions and explicitly required negative cases without starting a browser, process or capability.

**Current evidence:** `pnpm benchmark:planner` runs three fixed quick/core/release planning cases through `deterministic-v1`; all three currently pass with a 1.0 pass rate and average score. The same command accepts `PROOFKIT_PLANNER_PROVIDER=openai-compatible`, `PROOFKIT_PLANNER_BASE_URL` and `PROOFKIT_PLANNER_MODEL` for a real model. A workspace-owned Charter catalog and MCP readiness gate now reuse configured business scenarios without guessing assertions. The benchmark measures Charter structure only; it does not prove AIHR business execution.

The host benchmark now separates executable plumbing from agent behavior.
`node tests/host-evaluation-baseline.mjs` passed six synthetic cases through
the generated native stdio MCP launcher and real Chrome: core pass, seeded
business-relation defect, pending business state, project-coverage gap, quick
page check and inline Charter. Its verifier checks Mission/Run facts, report
and hashed evidence under an external workspace, with the source unchanged.
It also checks that start/status receipts claim no audited outcome and that
`await_test_result`, `get_mission_evidence` and `summary.json` agree on the
current `testVerdict` and full Mission evidence audit status.
The current fixture clicks a resume-acquisition button, captures the new file
ID from its response and requires the independent Oracle to read that same ID.
The verifier checks the action-window capture, Oracle source facts, cited source
digest and unchanged workspace config, connector and catalog Charters. All
eight scripted Web/Electron cases pass this stricter gate.
Two optional cases passed through a separately launched Electron/CDP process
using the same generated MCP connection; they distinguish a successful core
run from a seeded business-relation defect and reject a silent Web fallback.
Early real Codex runs encountered provider balance, cancelled MCP approvals,
and a stalled Windows elevated sandbox command. The evaluator retains these as
infrastructure or incomplete outcomes, stops after a provider/approval blocker,
and now bounds output-pipe draining after the host exits. A per-invocation
`--windows-sandbox unelevated` override made shell execution work on this host;
the benchmark permits its synthetic ProofKit MCP server's tool calls without
changing the user's saved Codex configuration. The synthetic page writes only
to its in-memory loopback fixture; connector write capabilities remain disabled.
This setting is for isolated evaluation and is not an application
permission or evidence of production-safe isolation.

On 2026-10-10, all eight real Codex CLI cases separately completed with
implicit Skill activation and passed the earlier saved-session verifier: six Web cases
(`quick-pass`, default `core-pass`, seeded `core-defect`, `core-pending`,
`project-gap`, and no-catalog `author-core`) plus Electron core pass and seeded
defect. The executable cases saved Mission/Run evidence with scope-correct
answers. The core cases used an independent `resume.terminal` Oracle; both
defect answers reported expected job 7 versus observed job 9 while the page
assertion passed. The pending worker remained inconclusive, the host authored
one validated inline Charter, and the unready project Mission executed no
product Run or whole-project pass. Observation-only `inspect_surface` Runs are
excluded from the host verifier's product-run count after checking their
read-only action shape. The `run_test` receipt now follows the active owner,
avoiding a stale second-approval instruction. A previous project-gap attempt
mixed the project Mission ID with a partial-scope report; the tighter Skill and
MCP next-action guidance prevented that in the verified rerun. Earlier host
deadline outcomes remain incomplete, even where a saved Mission passed. Those
eight cases used a fixed historical resume object and do not establish that the
Oracle verified the object created by the current action. Under the new
action-identity gate, all eight real Codex cases have now passed separately:
six Web cases and two Electron cases. The first project-gap rerun mislabeled
the unexecuted Mission as blocked after a wait receipt suggested approval;
the MCP contract now returns `testVerdict: not-asserted`, readiness gaps and
safe next actions, and its verified rerun preserved that distinction. These synthetic cases
establish a working path on this host, not a general false-pass rate or live
AIHR acceptance.

The MCP `await_test_result` tool now waits up to 30 seconds on the saved Mission
without starting or cancelling it. It returns a compact terminal summary and
current evidence integrity, a still-running receipt, or a no-owner action. The
portable Skill uses this path so the host does not have to infer completion from
repeated full Mission reads. MCP unit tests and all six scripted real-Chrome
host cases exercise it, including pass, seeded defect, pending business state,
project coverage gap, quick level and inline Charter. Real-host adherence to
the current identity gate is verified for the eight isolated cases above.

The planning quality gate is covered by tests for missing structural proof, partial discovery versus declared acceptance, whole-project requests, legacy gates, replay and model-reported high confidence. It is a deterministic readiness signal, not a calibrated probability or a substitute for real surface and business evidence. Curated release suites retain their reviewed declared-case scope; the missing-negative-case gap applies to generated release Charters. The real Web/Electron fixture also verifies submitted core scenarios with more than 200 static routes, independent HTTP business facts and a whole-project readiness gate. These checks do not constitute live AIHR acceptance or a measured whole-project workflow inventory.

The explicit release suite now snapshots multiple Charter IDs and its excluded catalog scope into one Mission. A two-workflow Web/Electron smoke drives the real MCP `run_test` path, performs eight primary/replay Runs per Mission, checks independent HTTP business facts, and detects a seeded resume-only defect while the other workflow stays green. This proves the configured suite slice, not automatic whole-project coverage or a live AIHR deployment.

The same real Web/Electron smoke now initializes a Git-bound workflow inventory and calls MCP `run_test` without a suite ID. The generated project Mission executes only `resume/web` and `login/electron`, replays those two pairs at `release`, verifies independent HTTP business facts and reports 2/2 declared checks with a matching source fingerprint. The final verdict remains `inconclusive` because inventory completeness is not independently established. A separate `core` project integration test confirms the same platform-specific graph without replay.

The real Web/Electron smoke also uses a separate external workspace with `quick` Charters and a source-bound inventory. A one-sentence MCP request executes one real browser Run per declared Charter/platform pair, with no business Oracle or replay. Both page checks are evidenced, while the Mission remains `inconclusive` for whole-project acceptance. A focused verifier regression keeps quick API route candidates unobserved even when a successful response event exists; `core` can count the same route only through a passing business-gated Run. The smoke fixture's large static map may truncate that API candidate, so the browser run proves the surface matrix and acceptance boundary, not complete route discovery.

On 2026-10-11, `pnpm test:smoke:electron:file` exercised a temporary `file:` Electron renderer and an HTTP Web page through one declared release suite: eight primary/replay Runs passed with independent HTTP business Oracles, and the declared dynamic route was observed on both surfaces. Electron snapshots saved `/resumes/:id` but removed the concrete hash ID; a same-prefix foreign HTML file is rejected by the route-coverage regression. This is isolated fixture evidence, not AIHR acceptance. At the time of that first smoke, ordinary Web and runtime diagnostic URLs could still contain concrete path segments.

The subsequent URL evidence projection hides undeclared HTTP paths in runtime events, surface snapshots and action receipts, and hides Electron file paths behind a document SHA-256 checked against the configured target. The file-route smoke now asserts that eight Runs retain route coverage without storing the concrete resume ID or file URL in `run.json` and `events.jsonl`. Declared configuration URLs, relative paths in visible UI text, connector evidence and screenshot pixels remain outside this projection.

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

**Current evidence:** the isolated Web/Electron smoke proves upload binding, terminal extraction, candidate identity, job relation, assessment state, workflow usage and an exact 300-point charge for the current upload. It detects seeded stale relation, wrong collection-Run binding, missing charge and extra cross-type charge defects with linked business evidence, and runs a duplicate-upload negative case whose Oracle proves duplicate reuse. A fixture-specific core Charter is selected from the external catalog by the one-sentence MCP request “测试简历获取” with no explicit level; both surfaces pass the success path and reject the seeded defects through `run_test`, `get_mission_status` and `get_mission_evidence`. Connector regressions additionally cover a mismatched upload response with correct persisted Run, extra same-type charge, duplicate or wrong-price charges and unavailable billing reads. The ordinary-upload reference Charter still needs a real surface assertion before catalog registration. A real isolated AIHR workspace and worker retry checks remain required before this phase is complete; fixture results do not establish live billing correctness.

**Current live workspace readiness (2026-10-10):** `proofkit environment` checked the external AIHR workspace again. Its configured Web endpoint `127.0.0.1:5274` was unreachable, no backend health endpoint was declared, and the result was `blocked` with `testVerdict: not-asserted`. The hashed observation is saved under the external workspace's `.proofkit/inspections/`; it started no application and performed no business write. A real `core` Charter still requires a source-matched Web/Electron target, isolated gateway and worker, test identity, fixture, and independent terminal Oracle. The saved-Mission proof audit now requires each required Run's passing Oracle source artifact in that Run's business evidence and links each confirmed product Finding to its own failing Oracle source artifact.

**Source/deployment audit (2026-10-11):** a fresh read-only environment check again found `127.0.0.1:5274` unreachable and returned `blocked`/`not-asserted`. The `aihr-test` Deployments are ready, but the gateway, resume-collection and assessment-worker image tags do not match local AIHR HEAD `dc781c3`; that checkout also has unrelated uncommitted changes. A temporary test-gateway forward on 28080 previously returned healthy endpoints and was stopped. Gateway `/api/v1/gateway/status` does not report a revision. These observations establish neither source/deployment equivalence nor business acceptance. The real “立即运行” path is Vue → Store → preload IPC → main-process manager → worker → shell-renderer backend bridge; the existing ordinary-upload Charter calls a connector instead. A separate UI Charter needs an observed click, an unambiguous identity for the resulting collection run, and independent terminal readers. See [the AIHR test map](aihr-resume-testing-map.md#桌面端采集上传).

The latest read-only external-workspace inspection, `environment-20261011112907-4eb066c2`, again returned `blocked`/`not-asserted`: its configured `127.0.0.1:5274` page was unreachable and no backend health endpoint was declared. The observation did not start a browser or execute AIHR business actions.

**Desktop acquisition connector (2026-10-11):** the reference Charter and Oracle now bind an actual UI response's new collection Run ID to bounded gateway reads of that Run, its single expected file, job relation, assessment worker outcome and workflow fact. Invalid metadata blocks at preflight; missing or ambiguous identities remain inconclusive. Isolated gateway regressions include wrong Run/file/job identities, failed runs, no files and retrying assessments. The real Chrome and Electron fixture smoke runs now exercise direct submission and an optional risk-confirmation click under one response listener, record the clicked/skipped branch, pass the correct binding and confirm a seeded wrong-job defect with business evidence. This prepares a real AIHR CDP trial, but the reference selectors, actual shell bridge request visibility, test account isolation and live terminal outcome are not yet verified.

**IPC visibility boundary (2026-10-11):** `pnpm test:smoke:electron-ipc` uses real Electron/CDP and a synthetic UI → preload IPC → main-process notification → shell-renderer `fetch` topology. The page network stream contains the POST, `captureResponse` binds its new Run ID, and an independent reader confirms the same terminal object. A main-process `fetch` control still creates a backend object but is invisible to the page and yields `inconclusive`, without a passing business Oracle. AIHR source currently routes its backend bridge through shell-renderer `fetch`, but its actual CDP target, confirmation timing and live request remain unverified.

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

Runner-owned assertion/Oracle receipt times now distinguish the first observed mismatch from the first evidenced business Finding. A missing-source Oracle no longer hides a later failing Oracle with independent source facts or lends it unrelated source hints. A Local Runner Mission regression checks that the report retains the earlier UI boundary while the product Finding, Diagnosis and RepairSuggestion cite the later business artifact and only its verified source hints. This does not prove source-level cause or correct repair code.

Real Chrome and Electron smoke cases now make a visible page assertion fail, then confirm the Finding only from the failed assertion's own saved snapshot. The release suite checks that all eight primary/replay Runs link their assertion-time snapshots through the Run report. Missing assertion observation stays inconclusive; these fixtures do not prove that every assertion or source-location hint is semantically correct.

Mission discovery and final verification now record bounded Git source fingerprints. A detected change during any completed declared-scenario Mission downgrades the current audited pass or failure to inconclusive without rewriting its saved verdict or Run evidence. Reopening a terminal result rechecks the source against its final fingerprint; verified post-run changes and an unavailable recheck after a complete Git capture also withdraw the current claim. A local Git-backed Mission regression verifies the pass, post-run edit, restored source and unchanged saved revision. The real-browser CLI/Action gate checks that an edited source makes `mission check` and Action check exit 2, then restores exit 0 when the exact source bytes return. Comparison also reports changes between runs and refuses repair verification when the candidate source changed during its own run. Missing or incomplete Git fingerprints remain explicitly unverified; generated output and served bytes are outside this fingerprint. The current AIHR checkout is capturable without copying its diff or file contents into evidence. Live AIHR execution remains pending until an isolated gateway, CDP session, test credentials and fixture are available.

Repair comparison now applies the same within-run source stability check to the failed baseline Mission. A baseline checkout change during execution prevents `verified-in-scope` even when its saved business Finding and the candidate's facts remain readable. The comparison result and report show baseline and candidate stability separately; missing Git fingerprints remain `unknown`. A real Web/Electron suite smoke passed after this gate was added.

Repair comparison now checks every confirmed baseline product Finding against materialized facts from a failing Oracle, including its saved digest and Run scope. Losing one Finding's fact in a multi-defect suite makes the repair claim inconclusive even when other defects remain evidenced. A candidate Oracle with several declared source artifacts is unverified if any one is missing. CLI repair gates return 0 for `verified-in-scope`, 1 for an evidenced reproduced defect, and 2 for inconclusive; replaying a failed baseline cannot return a green repair gate solely because the candidate Mission passed. The release-suite smoke damages and restores a baseline business artifact, then checks a passing candidate against an unlinked baseline Finding through the CLI. These are fixture-scoped integrity checks, not live AIHR repair proof.

The Windows loopback target check now records a listener's Git checkout before surface actions and blocks a different checkout by default. Windows and Linux listener lookup now filter by target loopback address or a same-family wildcard as well as port; a different loopback address alone cannot claim the target. The real Windows listener/Chrome continuity smoke passes with this filter. Linux has a fail-closed `/proc` listener and process-path implementation with address-aware socket parser regressions. An unprivileged [hosted Ubuntu run](https://github.com/shutu-hub/proofkit-ai/actions/runs/38107951937) returned unverified when a same-user process denied `/proc/<pid>/fd` link inspection (`EACCES`); its relationship to the target socket could not be established. The [privileged Ubuntu smoke](https://github.com/shutu-hub/proofkit-ai/actions/runs/38108258405) subsequently passed stable and replaced listener continuity plus foreign-checkout detection. This verifies that `/proc` path with runner administrator privileges, not ordinary-user access to every host process. Ordinary operation remains unverified when inspection is incomplete. This machine's WSL 1 socket table is empty, so local Linux inspection remains unverified. Repair comparison becomes inconclusive when only one side has target association evidence, target origins differ, or either listener is associated with another checkout. This still does not attest served bytes or detect a listener replacement between checks.

For a known unique listener PID, core/release Runs now recheck the binding before closing the surface, including after an assertion or Oracle throws. PID, origin or checkout drift, and an unavailable final association, downgrade an otherwise passed or failed Run to inconclusive; cancellation and pre-connection blocks retain their own verdicts. A returned final observation has its own artifact; a probe error records unverified continuity. The Run report shows both the status and available artifacts. Quick Runs keep the lower-cost initial check. This catches persistent listener replacement during long asynchronous checks, but not a transient swap that has reverted or PID reuse.

`pnpm test:smoke:target-continuity` now validates this with a real Windows listener and Chrome: one core Mission passes with a stable PID, then a second Mission replaces the listener during its Oracle and receives an inconclusive Run and Mission with different before/after PIDs and a report link. The temporary source Git checkout remains clean. The Windows job in [hosted CI](https://github.com/shutu-hub/proofkit-ai/actions/runs/38107514453) passed on `f8eb2d6` after the temporary-directory cleanup guard compared canonical paths. This proves the Windows process path on that isolated hosted fixture; it does not attest served bytes or exercise live AIHR.

Mission evidence now includes a bounded result projection and a static HTML/JSON snapshot in the external workspace. The report preserves the saved verdict, scope limits, missing execution slots, raw versus expected negative outcomes, the first failure and direct replay comparison. Report generation checks local evidence containment and available SHA-256 digests; missing or changed artifacts remain unavailable without rewriting the acceptance result. The release-suite smoke opens real Web/Electron fixture results in Chrome, checks wide and narrow layouts, follows a Run evidence link, verifies the CLI report command, and compares the good, seeded-defect and repaired-fixture Missions. This verifies report delivery and fixture-scoped repair evidence, not live AIHR acceptance or proof that an application source edit caused the repair.

**Gate:** seeded defects have a correct failure boundary and a repair suggestion that is rejected when evidence is insufficient.

## Phase 5: mobile and protocol extensions — adapter slice complete

**Goal:** add mobile coverage without changing the Run, Evidence or Verdict contracts.

- W3C WebDriver/Appium adapter for common Android/iOS/native and hybrid flows.
- Keep Maestro or device-cloud provisioning as separate adapters so the local Runner does not own device lifecycle.
- Keploy-style traffic fixtures for deterministic asynchronous backend setup.

**Current evidence:** `@proofkit/adapters` has a tested W3C WebDriver mobile adapter, and the contracts, Local Runner, CLI and MCP accept `mobile` as a surface. `inspect_surface` now reuses the ordinary Run lifecycle for mobile reconnaissance; its bounded label snapshot and screenshot are explicitly `not-asserted`, with no validated selector hints. `pnpm test:smoke:mobile` exercises native MCP inspection, a core Mission, real HTTP requests to a fake WebDriver, displayed-text assertions, independent business acceptance, defect evidence and session cleanup. The smoke also rejects session deletion after a passing business check and verifies a non-passing Run, Mission and JSON report. A failed or timed-out deletion preserves the adapter's session ID for retry; a successful driver response does not independently prove device-level cleanup. This does not exercise an emulator or device. An emulator-backed business run remains required.

The adapter now bounds each WebDriver response before parsing, leaves unavailable title/URL assertion facts inconclusive, and preserves an externally attached session by default. Mobile actions require exactly one currently matched and visibly confirmed element. Direct adapter regressions cover oversized streamed and declared responses, unavailable assertion facts, ambiguous or hidden action targets and explicit session deletion. The fake-driver MCP smoke confirms that an ambiguous target sends no click and yields an inconclusive Mission without a confirmed product defect. The real driver/device boundary remains unverified.

**Gate:** one business Charter runs on Web, Electron and a real mobile adapter with surface-specific actions but the same business Oracle contract.

## Phase 6: team and CI operations

**Goal:** make the local runner useful in continuous delivery.

- GitHub Action and machine-readable result contract.
- Retry and flake classification based on repeated evidence, not blind reruns.
- A first reporting slice now pairs already executed release primary/replay Runs by Charter and platform. The Mission JSON/MCP summary and HTML report show saved verdict agreement, divergence and unverified pairs, requiring the replay source link and Run-owned hashed evidence. A real Web/Electron suite smoke seeds one failed primary followed by a passing replay; the saved result reports one divergent pair across four compared pairs with intact Mission evidence. Divergence is an investigation signal, not a calibrated flake diagnosis; controlled repeated-run policy and root-cause classification remain open.
- Parallel run isolation and retention policies.
- Optional result aggregation; no hosted service required for the core product.

**Current CLI and Action gate:** `mission check` re-audits a saved Mission without importing its workspace integration, and returns JSON with historical and current verdicts plus a versioned `MissionResult` summary. `mission run`, `mission replay`, and `mission check` exit 0 for current pass, 1 for observed failure, and 2 for blocked, cancelled, inconclusive, or unasserted outcomes. A Composite Action now builds ProofKit from its own revision and wraps the same CLI for run or check mode, with GitHub outputs and a Step Summary. A real-browser local smoke covers passed and failed runs, an unstarted Mission, Action-created catalog and ad-hoc runs, first-use quick testing in a new external workspace, a core plan without a business Oracle, an integration that throws on import, and a tampered saved artifact. The [hosted Ubuntu Action smoke](https://github.com/shutu-hub/proofkit-ai/actions/runs/38107514509) passed on `f8eb2d6`: `uses: ./` executed a quick fixture Mission, then a second Action invocation re-audited its saved result. This proves the Composite Action path on that runner, not live AIHR acceptance. Broader CI isolation and retention remain open.

**Current distribution evidence:** `pnpm test:distribution` builds one `proofkit-ai` tarball, installs it in a fresh directory without the repository's `node_modules`, runs CLI onboarding, and calls the installed MCP server over stdio. The internal `@proofkit/*` modules are bundled into the two entrypoints. npm publication and cross-platform release verification remain open.

The tarball now includes the AIHR reference connector and five example Charters. Its installed CLI exports them to a new external workspace with `template install aihr`, reuses identical files and rejects conflicting files without overwriting them or writing to the tested source. The distribution smoke checks these boundaries and confirms that no Mission or Run starts. Examples still need isolated AIHR configuration, reviewed UI assertions and business readers; packaging does not establish live acceptance.

**AIHR first setup (2026-10-11):** `agent setup --template aihr` now installs the reference in the external workspace before the generic starter connector is created. The emitted Skill explains explicit selection, connector review and example Charter limits. Setup rejects a simultaneous connection check or host registration, because those would load the trusted connector before review. Existing generic or custom connectors still conflict without overwrite. CLI and installed-tarball tests cover fresh setup, repeat use, conflict protection and the absence of a Mission; this does not exercise an AIHR business workflow.

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
