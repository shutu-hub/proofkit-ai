# Agent Integration

ProofKit is designed to be used by a coding agent. The user describes the behavior in natural language; the agent calls the ProofKit MCP server and receives a compact, evidence-backed result. The tested repository does not need ProofKit test code in its business modules.

## Agent onboarding

After installing the built package, generate a native connection bundle:

```bash
proofkit agent setup --harness codex --root /path/to/source --workspace /path/to/test-workspace --install-skill
proofkit agent setup --harness claude-code --root /path/to/source --workspace /path/to/test-workspace --install-skill
```

Choose the command for the host you use. The external bundle lives under
`.proofkit/agents/<harness>/<content-hash>/` and contains a portable
`proofkit-test/SKILL.md`, `references/charter-authoring.md`, native `mcp.toml`
(Codex) or `mcp.json` (`mcpServers` for Claude/generic), and `setup.json`.
It uses the installed absolute Node/MCP entrypoint paths and binds both
`PROOFKIT_ROOT` and `PROOFKIT_WORKSPACE_ROOT`. Moving or uninstalling the
package requires a new export and host registration. The server name hashes
the source/workspace pair so different bindings have different names.

`--install-skill` installs to `~/.agents/skills/proofkit-test` for Codex or
`~/.claude/skills/proofkit-test` for Claude Code. `--skills-dir` overrides the
personal discovery directory and requires `--install-skill`. A generic harness
can consume the JSON fragment; its Skill discovery is host-specific, so an
explicit `--skills-dir` is required to install. DeepSeek Harness compatibility
depends on the actual harness's MCP and Skill support. These exports do not
verify its discovery implementation.

Use `connection.registration.command` and its **argument array** to register
the server with the host, or merge the generated native fragment through the
host's configuration workflow. The Claude registration uses user scope;
Codex uses its native `mcp add`. Setup does not execute these commands or edit
host MCP settings. Avoid joining arguments into an unescaped shell string:
paths and environment values can contain spaces or shell characters.
Refresh the host's Skill discovery if required, then call `inspect_test_scope`
through that host and check the source binding. A generated bundle reports
`connection.status: not-checked` and `testVerdict: not-asserted`.

The Skill preserves scope/platform/intensity, defaults to `core`, reuses
eligible saved scenarios or submits a validated Charter, requires independent
business evidence, follows one Mission through termination, and reports the
saved verdict with evidence and scoped repair comparison. It cannot configure
an unknown application's login, isolation, APIs or business invariants merely
by being installed. Configure those in the external workspace, then verify a
real workflow. Syntax and MCP connection tests do not establish model behavior.

Setup validates the existing project/workspace binding, canonicalizes output
paths, rejects source destinations and workspace path escapes, and never
imports trusted connector code. The default is external even when the source
has a legacy `.proofkit`. Identical exports/installations are reused; custom,
modified, incomplete or redirected artifact trees cause a conflict without
overwrite. Bundles are published from complete temporary directories. New
config/Skill content creates a new bundle; changing an existing installed
Skill requires reviewing and moving the old Skill before reinstalling.
The path checks are cooperative local protections, not an adversarial
filesystem sandbox or crash-durability guarantee.

## Host effectiveness check

The source checkout includes two distinct evaluations after `pnpm build`:

```bash
node tests/host-evaluation-baseline.mjs
node tests/host-evaluation.mjs --run --cases core-pass,core-defect,core-pending,project-gap,quick-pass,author-core
```

Set `PROOFKIT_ELECTRON_PATH` to a local Electron executable and run
`node tests/host-evaluation-baseline.mjs --cases electron-core-pass,electron-core-defect`
for the optional desktop cases. The first command uses the generated native MCP launcher and real Chrome, but scripted
tool calls. It verifies saved Missions, Runs, report links and SHA-256 evidence
for success, a wrong business relation, an unfinished worker, a whole-project
coverage gap, a quick page check and a submitted Charter without a catalog
entry. Its `scripted-mcp-baseline` result **does not measure an AI host**.
The desktop cases use a separate Electron profile and CDP port, and the
verifier rejects an answer or saved Run silently switched to Web.

The second starts the installed Codex CLI with its existing provider and
credentials. It activates `$proofkit-test`, records the host's actual MCP calls
and structured answer, then checks both against saved Mission/Run state. Add
`--implicit-skill` to measure ordinary natural-language activation separately.
It uses only synthetic loopback facts; it does not contact AIHR or authorize
business writes. Model usage may incur provider charges. A provider access
failure or cancelled host MCP call is reported as `infrastructure-blocked`,
and remaining cases are left unrun. Neither is scored as a model or product
failure. Reports and event traces are retained under the printed temporary
evaluation root. Model adherence and false-pass rates require an unblocked
real-host run; the scripted baseline cannot establish them.

ProofKit marks source/scope/catalog/status reads with MCP read-only hints.
Actions that generate workspace evidence or execute a Mission do not receive
that hint. The host's own tool approval remains authoritative; the annotations
are scheduling hints, not permissions.

`--allow-capability-writes` emits the existing process-level operator opt-in.
It does not change workspace side-effect policy, provide credentials or prove
test-environment isolation. Existing execution gates still apply.

Discovery/configuration references:
[Codex Skills](https://developers.openai.com/codex/skills/),
[Codex MCP](https://developers.openai.com/codex/mcp/),
[Claude Code Skills](https://code.claude.com/docs/en/skills),
[Claude Code MCP](https://code.claude.com/docs/en/mcp).

## Recommended connection

Register one local MCP server for the project root. Clients with MCP support, including Codex and Claude Code, use the same high-level tools. DeepSeek Harness can use this interface when its harness supports MCP, or invoke the CLI otherwise:

```text
discover_project
inspect_test_scope
inspect_test_environment
inspect_surface
list_test_charters
list_test_suites
run_test
get_mission_status
get_mission_evidence
cancel_mission
replay_mission
compare_missions
```

`run_test` is the shortest path for an agent:

```json
{
  "intent": "测试简历获取，确认文件生成、候选人识别和终态可用",
  "level": "core",
  "surface": "electron"
}
```

The response contains `missionId`, the resolved level and the running status. The agent then polls the status until the mission reaches a terminal state and reads evidence once. For a review-first workflow, call `create_test_mission`, inspect the task graph, call `approve_test_plan`, and then call `start_mission`.

For an unfamiliar project, first call `inspect_test_scope({ surface: "electron", level: "core" })`. It joins source-backed candidate entry points/routes, compatible saved Charter/Suite checks, registered business Oracles and capability input hints in one bounded response. `focus` optionally filters by a literal source-path, alias or registration substring; it does not understand a whole natural-language request. `limit` defaults to 20 and is capped at 50 details per section. Use total/matched/omitted counts and `inventory.truncated` to describe the actual inspected scope. Gin group prefixes are composed conservatively within each file; `inventory.routeDiagnostics` gives unresolved declaration locations and total/omitted counts, never guessed paths. Route `declared` status only means a catalog mapping exists; it can coexist with `planReady: false` and never proves execution.

`planReady` validates saved plan structure and registered operation names using the normal catalog validators. It does not check credentials, endpoints, fixture readiness or business truth. The tool returns `not-asserted` and `not-run`, creates no Mission/Run and invokes no connector operation or surface connection. Loading the service still loads trusted connector registration code. Capability `inputShape` omits default values and user callbacks, marks incomplete descriptions as partial, and leaves runtime Zod validation authoritative. Follow with live `inspect_surface`, then reuse a ready catalog ID or submit a complete Charter to `run_test`; register a trustworthy business Oracle when the requested level requires one.

For a large repository, use a module path or name, for example `inspect_test_scope({ focus: "resume-collection", level: "core", surface: "web", limit: 50 })`. Focus now prioritizes retention before route/entry caps, rather than filtering only the first global candidates. A matching eligible Charter alias also prioritizes its declared routes; `inventory.retentionFocus` records the normalized query. Totals describe retained candidates, with duplicate declarations in one source collapsed; `omitted` describes response details omitted from that slice. File discovery and reads remain bounded, so `truncated` must still be reported. Route-text focus cannot recover unscanned files, and filesystem discovery only prioritizes paths it has discovered.

Before connecting to a configured Web/Electron page, call `inspect_test_environment({ surface: "electron", timeoutMs: 5000 })` (CLI: `proofkit environment --root /path/to/source --surface electron`). It observes configuration, the surface HTTP status where applicable, CDP discovery HTTP status, up to eight declared backend health endpoints and the existing local listener/source association. All checks share one 100–15000 ms deadline. It returns `checks-passed`, `blocked` or `incomplete`, a `notChecked` list, and a JSON artifact path with SHA-256 in the external workspace. The CLI exit codes are 0, 1 and 2 respectively.

Environment observations always carry `testVerdict: not-asserted`. They do not start an app/browser, create a Mission/Run, or invoke connector preflight, setup, capability or Oracle operations. Service creation still loads trusted connector registration code. Probes issue GET requests, inspect status at response headers, follow no redirect, and retain no body, response headers, query, fragment or raw network error. Endpoint paths remain visible. MCP health/CDP probes require loopback; a configured Web surface follows the ordinary configured-origin policy. WebSocket CDP endpoints need live surface inspection and remain unverified here. Missing source association or backend health configuration stays explicit. A 200 response does not prove a CDP session, selected page, login, fixture availability, isolated test scope or business terminal state. Use `notChecked` to continue with the required checks; never convert this result into a product pass. Cancellation propagates the caller's reason; an expired observation deadline returns incomplete checks as unverified.

Before drafting a new Charter, call `inspect_surface({ surface: "web" })` or `inspect_surface({ surface: "electron" })` against an already running local page. It records a read-only observation Run and returns bounded controls, including hidden file inputs with `inputType: "file"` and `visible: false`, and a selector only when it matched exactly one element at inspection time. The result says `testVerdict: "not-asserted"`; it is reconnaissance, not a pass. Control hints cover the main frame only, are capped at 60, omit input values, and can become stale after navigation. Web/Electron `click`, `fill`, `press` and `setInputFiles` recheck selector uniqueness during the test Run and fail on ambiguity. The Run keeps snapshot, screenshot and event evidence in the external workspace. Use isolated test data because screenshots can contain everything visible on the page.

For a page that renders asynchronously, configure `surfaces.web.readyWhen` or
`surfaces.electron.readyWhen` once, or override it in
`inspect_surface({ surface: "web", readyWhen: { text: "Log in", timeoutMs: 5000 } })`.
CLI equivalent: `proofkit inspect --ready-text "Log in" --ready-timeout-ms 5000`.
The prerequisite uses the existing `waitForText` step, then observes the page;
it matches visible text containing the configured string in the main frame.
Text is trimmed, accepts 1–512 characters, and must describe public UI content;
it is stored with the Run. Timeout is 100–15000 ms (default 5000), within the
existing 30-second inspection deadline and configured Run deadline.
`readiness.status` is `not-requested`, `observed` or `unverified`. A missing
condition produces a failed inspection with evidence, no successful snapshot,
and still `not-asserted`; it does not establish a product bug. Observing text
proves only that prerequisite at that moment, not app stability or login.
The response also retains up to ten already classified `runtimeFindings`
(messages capped at 2000 characters) and `runtimeFindingsOmitted`; full findings
remain in Run artifacts. An observed page can have failed `runtimeHealth`.
MCP cancellation reaches the same Run lifecycle. Inspection uses trusted
integration preflight/setup/cleanup hooks when configured; those hooks remain
responsible for test isolation even when browser actions only observe.

When the workspace has no matching catalog entry, the host agent can inspect the source and `discover_project` result, then submit a complete structured Charter directly to `run_test` or `create_test_mission`. This is a one-Mission test contract; it does not modify the tested project or silently register a reusable catalog entry. For example, after the workspace has registered a read-only `resume.terminal` Oracle:

```json
{
  "intent": "检查简历页面和后台处理终态",
  "surface": "web",
  "charter": {
    "intent": "检查简历页面和后台处理终态",
    "level": "core",
    "sideEffectPolicy": "deny",
    "actions": [{ "kind": "goto", "url": "http://127.0.0.1:5173/resumes" }],
    "assertions": [{ "kind": "text-visible", "text": "简历" }],
    "oracles": ["resume.terminal"]
  }
}
```

ProofKit validates the submitted schema, registered Oracle and Capability names, navigation origin and side-effect policy before persisting the Mission. It recomputes planning gaps from the Charter and bounded Project Map; a submitted confidence score or claimed evidence gap does not decide readiness. MCP `click`, `fill`, `press` and `setInputFiles` actions require `sideEffectPolicy: allow` in the affected scenario and `policies.sideEffects: allow` in the test workspace. Registered write Capabilities also require the separate process-level operator opt-in described below. After a workflow is proven, save its Charter in the external workspace catalog so later one-sentence requests reuse the reviewed test.

For a file-upload workflow, prepare a synthetic fixture at
`<workspaceRoot>/.proofkit/fixtures/resume.pdf`, inspect the page's actual file
input, and use its unique selector in the Charter:

```yaml
actions:
  - kind: setInputFiles
    selector: 'input[type="file"][name="resume"]'
    files: [.proofkit/fixtures/resume.pdf]
```

The selector is an example; discover the application's actual control first.
Web/Electron support hidden file inputs. One action accepts 1–10 files with a
20 MiB total limit. Its input facts record names, sizes, SHA-256 and MIME types,
without recording the uploaded bytes. Include any form fields and submit
action, a positive page assertion, and an independent business Oracle for
`core` or `release`. File selection alone proves neither a submitted request
nor completed processing. Snapshots and screenshots can retain page echoes;
use synthetic inputs. Mobile file selection is currently blocked.

Preserve fixture bytes and order for `replay_mission`. Primary and negative
Runs use their own baseline input facts. Changed, missing or unchecked inputs
prevent expected negative outcomes from passing and make repair comparison
inconclusive; create a new Mission for a new input dataset. Fixture validation
occurs at the file action, so earlier form actions may already have executed.

To bind acceptance to the object returned by this submission, replace the
submit click with `captureResponse`. The following is an illustrative API
contract, not a ready-made AIHR workflow; inspect real routes and controls:

```yaml
intent: Verify one resume submission and its terminal processing state
level: core
sideEffectPolicy: allow
actions:
  - kind: goto
    url: http://127.0.0.1:5173/resumes
  - kind: setInputFiles
    selector: 'input[type="file"][name="resume"]'
    files: [.proofkit/fixtures/resume.pdf]
  - kind: captureResponse
    name: resume-created
    trigger:
      kind: click
      selector: 'button[data-testid="submit-resume"]'
    response:
      url: http://127.0.0.1:8080/api/v1/resumes
      method: POST
      statuses: [200, 201]
      fields:
        fileId: { pointer: /data/file_id, type: id }
    requestWindowMs: 500
    timeoutMs: 10000
assertions:
  - kind: text-visible
    text: Resume submitted
oracles: [resume.terminal]
```

Register a read-only identity/status check in the external config. The example
assumes the existing independent GET accepts `file_id` and returns
`data.file_id` and `data.status`; ProofKit does not create that application API:

```yaml
policies:
  sideEffects: allow
oracles:
  - name: resume.terminal
    url: http://127.0.0.1:8080/api/v1/resume-status
    query:
      file_id:
        source: response
        stepId: step-003
        field: fileId
        matchPointer: /data/file_id
    statusPointer: /data/status
    successValues: [completed]
    failureValues: [failed]
    deadlineMs: 30000
```

Step IDs are one-based action positions; update the binding if actions are
inserted. Use the actual API's field pointers and status values. Missing or
ambiguous response identity is inconclusive. A different independent object
ID fails even if that object has completed. A configured status Oracle proves
only these declared facts; use a workspace connector for stored file bytes,
candidate identity, job relation and other business invariants.

Capture accepts one matching main-frame request started in the action window,
then only the selected scalar fields from its JSON response. It rejects
redirects and accepts at most 64 KiB of decoded JSON; this is not a hard
Playwright memory limit. Temporal association alone does not prove causation.
Use isolated data and account for background requests. Both the scenario and
workspace must allow side effects, and the endpoint must satisfy the MCP
navigation-origin policy. Mobile capture is currently blocked.

Replay preserves fixture input identity but captures a fresh business ID.
For AIHR's manual intake, the verified POST is
`/api/v1/resume-collection/candidate-intakes`, returning file, candidate,
resume-version, job and relation IDs. The workspace-owned
`aihr.manualCandidateIntake` Oracle binds all five captured IDs and the selected
file digest to independent readers, then waits for parsing and assessment/task
success. Copy both reference connector files to the external workspace.
See [the manual intake contract](aihr-resume-integration.md#manual-candidate-intake)
for exact field pointers, metadata, isolation checks and latest-state limitations.
Discover the actual page actions and a positive assertion before submitting the
Charter; a manual intake must not be accepted by querying an unrelated online
collection workflow.

For repair verification, replay the failed Mission after the application change. The new Mission stores `replayOfMissionId`; once it finishes, `get_mission_evidence` includes a comparison with the source Mission. `compare_missions` reads the same comparison directly. It requires a direct replay, the same project/workspace and saved Charter or suite scope, a confirmed baseline product finding linked to a materialized business source artifact, and a complete passing candidate with its own independent source facts. Primary, required replay, and declared negative Runs are paired by Charter, surface and run kind. A missing Run, changed scope, unmaterialized artifact or unfinished candidate is `inconclusive`; a repeated evidenced Oracle failure is `defect-reproduced`. `verified-in-scope` does not identify which source change fixed the symptom.

The result also includes `sourceChange` and `candidateSourceStability`. These come from bounded, read-only Git fingerprints captured before execution and after verification; only digests and counts are stored. `sourceChange=unknown` means the source state could not be captured completely. A candidate whose source changed during its own run is inconclusive even if the business checks passed.

For repeatable business workflows, register a curated Charter in the external workspace's `.proofkit/config.yaml`:

```yaml
charters:
  - id: resume-core
    path: .proofkit/charters/resume-core.yml
    aliases: [简历获取, 简历上传]
    level: core
    surfaces: [web, electron]
```

The Charter must declare a real surface assertion and, for `core` or `release`, a registered independent business Oracle. An agent can say “测试简历获取核心链路”; ProofKit selects the matching alias at the requested level and surface, records `catalogId`, and executes the saved Charter. A more specific alias may supersede its own generic substring; matches for distinct workflows require an explicit `charterId`. An explicit ID supplies its catalog level when `level` is omitted. A `release` Charter must support both Web and Electron when either is selected. Ad-hoc `url`, `expect`, Oracle, mode or side-effect options bypass automatic catalog matching. `list_test_charters` shows the available IDs and aliases. The source project remains untouched.

For a multi-workflow release run, declare the exact scope in the same external config:

```yaml
suites:
  - id: release-critical
    aliases: [上线完整回归]
    level: release
    charterIds: [resume-release, login-release]
    surfaces: [web, electron]
```

Both referenced Charters must be registered `release` entries, support both surfaces, and declare their own assertions and business Oracles. Call `run_test({ intent: "上线完整回归", suiteId: "release-critical", surface: "web" })`, or use the suite's alias without `suiteId` when it is unambiguous. `list_test_suites` shows the configured scope. A suite runs only its declared Charters; the result lists other registered release Charters as uncovered catalog scope. A direct `charterId` still runs one Charter.

To measure discovered route scope, add reviewed `routeTargets` to each catalog Charter in the same external config:

```yaml
charters:
  - id: resume-release
    path: .proofkit/charters/resume-release.yml
    aliases: [简历获取上线回归]
    level: release
    surfaces: [web, electron]
    routeTargets:
      - kind: web
        path: /resumes
        source: apps/resume/src/router.ts
      - kind: api
        method: POST
        path: /api/v1/resumes
        origin: http://127.0.0.1:8080
        source: services/gateway/router.ts
```

`source` may be omitted when the scanned route path is unique. An API target also needs its HTTP method and the exact gateway origin, so a same-path request to another service cannot count. `get_mission_evidence.suiteScope.routeCoverage` reports candidate, mapped and observed route counts, bounded gap details with omitted counts, stale or ambiguous declarations, and whether the project inventory was truncated. A route is **observed** only when its mapped Charter passes with independent business evidence on every required surface and both primary and replay runs visit the Web path or receive a matching 2xx API response. The response is linked to that Run's network event log; no runtime URL is copied into the Mission coverage observation. The saved Mission keeps the mapping used for the run, even if the catalog later changes. Coverage gaps are informational and do not change a suite's workflow verdict. These counts describe static candidate routes, not whole-project coverage; calls made only by a backend worker are not browser network observations.

The final evidence gate is checked per primary run and required replay, not across pooled runs. An Oracle must return at least one sanitized observation fact; ProofKit's own Oracle result file does not count as that fact. A negative case cannot make an unverified main path green.

If a one-sentence request has no suitable Charter and the planner cannot supply an assertion or required Oracle, `run_test` returns `readiness.ready=false` and does not start the surface. Its next-tool hints point to `inspect_test_scope`, `inspect_surface`, `plan_test` and `run_test`. The agent can inspect the gaps and call `run_test` again with a complete structured Charter. Readiness checks structural prerequisites; they do not prove the assertion is meaningful.

## What the agent receives

The status result is intentionally short and structured:

- resolved test level and why it was selected;
- requested acceptance scope, static inventory completeness and outstanding workflow coverage gaps;
- mission and run verdict;
- task graph and first failed boundary;
- bounded `AgentStep` summaries showing the agent decision, selected tool, lifecycle status and links to observations/evidence;
- confirmed, suspected or unverified findings;
- diagnosis and repair suggestions only when the evidence supports them;
- evidence references to screenshots, snapshots, reports, process records and business Oracle output.

The agent should report a product bug only for a `confirmed` product finding with linked evidence. A missing browser, permission, login, test data or business terminal observation is reported as `blocked` or `inconclusive` and includes the next required action.

`get_mission_evidence` also returns a bounded `summary` and the path to a compact HTML `report`. Give the user this entry point alongside the verdict, tested scope and first actionable issue. The report shows the saved Mission verdict, per-scenario/platform results, missing runs, business proof, findings and replay comparison. A negative case retains its raw failed/blocked result and separately states whether it matched the declared expectation. Task counts are progress, not coverage. The adjacent `summary.json` exposes the same presentation contract without tool inputs/outputs or raw business payloads.

Reports are static snapshots with revision and generation time. A new evidence request regenerates them; they do not refresh themselves. Missing files, rejected paths and recorded-digest mismatches appear as unavailable evidence rather than working links. When generation fails, `reportUnavailable` explains the limitation and the saved verdict/evidence remain readable. Report rendering never decides acceptance. Whole-project workflow coverage is still unmeasured.

`get_mission_evidence.targetBindings` lists the source-to-target process association for each Web/Electron Run. On Windows, a loopback listener whose code path points to a different Git checkout blocks the Run by default; an unknown association is reported as `unverified`. A matching process path does not prove the server delivered the current source bytes, so the agent should not describe it as full source attestation. The test workspace may set `policies.targetBinding: record` for an intentional cross-checkout diagnostic.
Repair comparison is `inconclusive` when one side has no target association record, the target origin changes, or either recorded listener belongs to a different checkout. Historical Runs with no association record on either side retain their existing comparison behavior; a repeated `unverified` association still cannot prove served-byte identity.

The protocol deliberately separates the audit layers: `AgentStep` explains why a task was selected, `ToolCall` records the registered operation, `Observation` records typed facts, and `Evidence` points to artifacts that can be reviewed. The evidence response is bounded; large tool inputs and outputs remain in the local Mission file rather than being copied into every MCP response.

## Project onboarding

The zero application-code-change path needs a local Web, Electron or Appium-compatible mobile endpoint and a ProofKit config. A new project's test files default to `~/.proofkit/workspaces/<project-name>-<path-hash>/.proofkit/`. CLI `--workspace` and MCP `PROOFKIT_WORKSPACE_ROOT` select an explicit test workspace; `--root` / `PROOFKIT_ROOT` always identify the tested source. An existing project-local `.proofkit` remains compatible unless an explicit workspace is supplied.

Optional `<workspaceRoot>/.proofkit/integration.mjs` adds typed capabilities, business Oracles and setup/cleanup for workflows such as resume acquisition. It is trusted local code, not sandboxed JavaScript, and uses the same lifecycle as CLI and MCP. A business connector is needed when UI observations alone cannot establish the requested outcome.

For a locally installed `proofkit-ai` tarball, register its `proofkit-mcp` command with `PROOFKIT_ROOT=/path/to/source` and `PROOFKIT_WORKSPACE_ROOT=/path/to/test-workspace`. From a source checkout, use `node /path/to/proofkit-ai/packages/mcp/dist/server.js`. Both commands expose the same tools; the npm registry release is still pending. Once the local surface and business checks are configured, the agent calls `run_test` and receives a Mission ID instead of repeatedly supplying CDP instructions.

For a multi-window Electron app, select its renderer once in the external workspace configuration:

```yaml
surfaces:
  electron:
    cdpUrl: http://127.0.0.1:9222
    targetTitleContains: AIHR
```

`targetUrlPrefix` can be used instead of or together with the title. Web CDP attachment supports the same fields. ProofKit waits briefly for the page to appear and stops if none or several pages match, so an agent cannot accidentally test an unrelated window.

The integration should expose opaque IDs and sanitized facts. It should not expose arbitrary shell, SQL, filesystem or credential operations. Write capabilities require an explicit test environment, a Charter side-effect policy of `allow`, and the runner-level write opt-in.

For UI login fields, use a `fill` action with `value: { env: "PROOFKIT_TEST_PASSWORD" }` and set that variable in the local test runner process. ProofKit resolves it immediately before the action; the Charter, Mission, Run JSON and step event retain only the variable name. A missing or empty variable blocks before browser connection, and replay reads the current value. A literal `fill.value` remains supported for non-sensitive fixture text and is saved in evidence. Screenshots, page text, application logs and business integrations can still reveal a value that the application displays, so use isolated credentials and keep evidence access restricted.

For MCP, the operator sets `PROOFKIT_ALLOW_CAPABILITY_WRITES=1` when launching the server. The workspace must also set `policies.sideEffects: allow`, and the selected Charter and capability must each allow the write. The agent cannot turn on this process-level switch through a tool argument. CLI uses `proofkit mission run <mission-id> --approve --allow-capability-writes`. Use this only with a dedicated test environment and the integration's preflight checks.

### Scoped setup and cleanup

A connector that provisions data declares `setupPolicy` and returns a resource
handle. The same operator switch, workspace policy and Charter `allow` are
required for write setup. This example assumes a separately operated test-only
fixture API with scoped creation, deletion and readback; it does not create
isolation in a shared production or development deployment. Keep the module in
the external workspace and add the required business Oracles separately.

```javascript
export function createIntegration() {
  const origin = process.env.PROOFKIT_FIXTURE_API;
  if (!origin || new URL(origin).hostname !== "127.0.0.1") {
    throw new Error("Configure the isolated loopback fixture API");
  }
  async function removeAndReadback(scope, signal) {
    const url = new URL(`/api/v1/test-scopes/${scope}`, origin);
    const deleted = await fetch(url, { method: "DELETE", signal });
    if (!deleted.ok && deleted.status !== 404) throw new Error("Fixture removal failed");
    const state = await fetch(url, { signal });
    if (state.status !== 200 && state.status !== 404) throw new Error("Fixture readback failed");
    return [{
      resourceId: "scope", status: state.status === 404 ? "removed" : "retained",
      evidence: { statusCode: state.status },
      readback: { reader: "fixture.scoped-get", scope,
        observedAt: new Date().toISOString(), exists: state.status !== 404 },
    }];
  }
  return {
    name: "isolated-fixture",
    version: "1.0.0",
    setupPolicy: {
      sideEffect: "write",
      environments: ["test"],
      cleanupTimeoutMs: 5000,
    },
    async setup({ runId, signal }) {
      const url = new URL(`/api/v1/test-scopes/${runId}`, origin);
      try {
        const created = await fetch(url, { method: "PUT", signal });
        if (!created.ok) throw new Error("Fixture setup failed");
      } catch (error) {
        // A request can write before its response fails. Roll back even before
        // returning the handle, using a fresh bounded signal.
        try {
          const rollback = await removeAndReadback(runId, AbortSignal.timeout(5000));
          if (rollback[0].status !== "removed") throw new Error("Fixture rollback retained resources");
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Setup rollback was not established");
        }
        throw error;
      }
      return {
        resources: [{ resourceId: "scope", kind: "fixture-namespace",
          scope: runId, evidence: { owner: runId } }],
        cleanup: ({ signal: cleanupSignal }) => removeAndReadback(runId, cleanupSignal),
      };
    },
    async recover({ runId, resources, signal }) {
      if (resources.length !== 1 || resources[0].resourceId !== "scope"
        || resources[0].kind !== "fixture-namespace" || resources[0].scope !== runId
        || resources[0].evidence.owner !== runId) {
        throw new Error("Recovery resource does not belong to this connector Run");
      }
      return removeAndReadback(runId, signal);
    },
  };
}
```

Resource IDs must be unique within a Run; facts are limited to scalar values,
and no credentials or response bodies belong in them. The cleanup callback
receives a fresh signal after cancellation and must honor it. Deletion
acknowledgement alone does not establish removal: read the same scope after
deletion. Keep deletes idempotent and validate ownership in the fixture API.
Returning an old cleanup function remains compatible, reported as `completed`
rather than `verified`. For registered resources, a connector can additionally
export an explicit version and a versioned `recover({ runId, signal,
projectRoot, workspaceRoot, environment, resources })` hook. After an unexpected
process exit, inspect the Run first:

```text
proofkit resources inspect <run-id> --root <project> --workspace <workspace>
proofkit resources recover <run-id> --root <project> --workspace <workspace> --allow-capability-writes
```

The equivalent MCP tools are `inspect_run_resources` and
`recover_run_resources`. Recovery accepts only the original connector name and
version, a validated atomic registration journal and matching Run event
provenance. It requires the operator write opt-in, workspace
`policies.sideEffects: allow`, and a connector write setup policy for the saved
environment. It claims the Run lease before deleting anything, verifies scoped
readback, and saves an independent recovery attempt artifact. A successful
recovery is never a product pass and never changes the original Run verdict.
Active/unverifiable owners, tampered or redirected evidence, and missing
recovery hooks fail closed. Provenance scanning accepts at most a 16 MiB log
prefix and 256 KiB per event; missing registration within those bounds refuses
automatic cleanup. Connector version matching uses a declared string, not a
code signature. Trusted
JavaScript cannot be forcibly stopped by `AbortSignal`; a hook that ignores the
deadline keeps ownership until it settles or the process exits. A connector
must still roll back writes made before it returned a handle. Power-loss
durability is unverified despite the flushed temporary file and atomic rename.

Read-only page inspection denies a declared write setup, so prepare its
environment in advance or use a separate read-only connector.

## Choosing a level

| User wording | Level | Agent behavior |
| --- | --- | --- |
| “快速看一下登录页能不能打开” | `quick` | Run the shortest observable path and return quickly. |
| “测试简历获取核心链路” | `core` | Require an independent business result and retain replayable evidence. |
| “上线前完整回归 Web 和 Electron” | `release` | Select a declared suite or a single Charter, then run and replay each selected workflow on both surfaces. Verify business evidence for every workflow and surface; execute every explicitly declared negative or recovery case. |
| “在 Android 模拟器上测试登录” | `core` | Use the configured `mobile` W3C WebDriver surface with the same assertions, Oracles and evidence contract. |

If the user does not specify a level, ProofKit selects `core`. An explicit `quick` request is never silently upgraded by the planner.

## Choosing acceptance scope

`level` describes test intensity; `coverage` describes what the verdict accepts. The default `declared` scope accepts only the saved Charter or suite scenarios. A successful release suite remains acceptance of those scenarios, even if the source scan contains more routes. A partial inventory is retained in `planning.coverage` and does not by itself stop a complete declared module test.

For a whole-project request, retain the user's original intent and send `coverage: "project"`. ProofKit also recognizes common whole-project phrases, but the host agent is responsible for faithful scope selection. Whole-project workflow inventory and execution coverage proof are not implemented, so this request currently returns a planning gate rather than a whole-project pass. Missing assertions or independent business proof still block automatic core execution. An explicit caller choice of `declared` is recorded; never use it to silently narrow the user's request. Saved legacy gates require replanning and are not cleared by replay.

```javascript
run_test({ intent: "测试简历获取核心链路", level: "core", coverage: "declared", surface: "electron" });
run_test({ intent: "上线前测试整个项目", level: "release", coverage: "project", suiteId: "release-critical" });
```

The first call can run a ready registered or submitted workflow; the second reports missing whole-project proof. `planning.coverage.inventory` is `bounded`, `partial` or `not-scanned`, and `workflowCoverage` is currently `unmeasured`. The agent must describe a passed declared test as the saved scenario's result and retain these coverage limits in its final explanation.

## CLI fallback

The same lifecycle is available without an agent:

```bash
proofkit mission create "测试简历获取" --surface electron --level core
proofkit inspect --adapter electron --cdp http://127.0.0.1:9222
proofkit mission create "测试简历获取" --surface electron --charter .proofkit/charters/resume-core.yml
proofkit mission run <mission-id> --approve
proofkit mission status <mission-id>
proofkit mission evidence <mission-id>
proofkit mission report <mission-id>
```

This is useful for CI, debugging MCP configuration, and reproducing an agent result locally. CLI, MCP and CI share the same Local Runner, Mission files and run evidence format.
