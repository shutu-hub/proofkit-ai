# Agent Integration

ProofKit is designed to be used by a coding agent. The user describes the behavior in natural language; the agent calls the ProofKit MCP server and receives a compact, evidence-backed result. The tested repository does not need ProofKit test code in its business modules.

## Recommended connection

Register one local MCP server for the project root. Clients with MCP support, including Codex and Claude Code, use the same high-level tools. DeepSeek Harness can use this interface when its harness supports MCP, or invoke the CLI otherwise:

```text
discover_project
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

Before drafting a new Charter, call `inspect_surface({ surface: "web" })` or `inspect_surface({ surface: "electron" })` against an already running local page. It records a read-only observation Run and returns bounded visible controls, including a selector only when it matched exactly one element at inspection time. The result says `testVerdict: "not-asserted"`; it is reconnaissance, not a pass. Control hints cover the main frame only, are capped at 60, omit input values, and can become stale after navigation. Web/Electron `click`, `fill` and `press` recheck selector uniqueness during the test Run and fail on ambiguity. The Run keeps snapshot, screenshot and event evidence in the external workspace. Use isolated test data because screenshots can contain everything visible on the page.

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

ProofKit validates the submitted schema, registered Oracle and Capability names, navigation origin and side-effect policy before persisting the Mission. It recomputes planning gaps from the Charter and bounded Project Map; a submitted confidence score or claimed evidence gap does not decide readiness. MCP `click`, `fill` and `press` actions require `sideEffectPolicy: allow` in the affected scenario and `policies.sideEffects: allow` in the test workspace. Registered write Capabilities also require the separate process-level operator opt-in described below. After a workflow is proven, save its Charter in the external workspace catalog so later one-sentence requests reuse the reviewed test.

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

If a one-sentence request has no suitable Charter and the planner cannot supply an assertion or required Oracle, `run_test` returns `readiness.ready=false` and does not start the surface. The agent can inspect the project, use `list_test_charters` or `plan_test`, then call `run_test` again with a complete structured Charter. Readiness checks structural prerequisites; they do not prove the assertion is meaningful.

## What the agent receives

The status result is intentionally short and structured:

- resolved test level and why it was selected;
- mission and run verdict;
- task graph and first failed boundary;
- bounded `AgentStep` summaries showing the agent decision, selected tool, lifecycle status and links to observations/evidence;
- confirmed, suspected or unverified findings;
- diagnosis and repair suggestions only when the evidence supports them;
- evidence references to screenshots, snapshots, reports, process records and business Oracle output.

The agent should report a product bug only for a `confirmed` product finding with linked evidence. A missing browser, permission, login, test data or business terminal observation is reported as `blocked` or `inconclusive` and includes the next required action.

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

For MCP, the operator sets `PROOFKIT_ALLOW_CAPABILITY_WRITES=1` when launching the server. The workspace must also set `policies.sideEffects: allow`, and the selected Charter and capability must each allow the write. The agent cannot turn on this process-level switch through a tool argument. CLI uses `proofkit mission run <mission-id> --approve --allow-capability-writes`. Use this only with a dedicated test environment and the integration's preflight checks.

## Choosing a level

| User wording | Level | Agent behavior |
| --- | --- | --- |
| “快速看一下登录页能不能打开” | `quick` | Run the shortest observable path and return quickly. |
| “测试简历获取核心链路” | `core` | Require an independent business result and retain replayable evidence. |
| “上线前完整回归 Web 和 Electron” | `release` | Select a declared suite or a single Charter, then run and replay each selected workflow on both surfaces. Verify business evidence for every workflow and surface; execute every explicitly declared negative or recovery case. |
| “在 Android 模拟器上测试登录” | `core` | Use the configured `mobile` W3C WebDriver surface with the same assertions, Oracles and evidence contract. |

If the user does not specify a level, ProofKit selects `core`. An explicit `quick` request is never silently upgraded by the planner.

## CLI fallback

The same lifecycle is available without an agent:

```bash
proofkit mission create "测试简历获取" --surface electron --level core
proofkit inspect --adapter electron --cdp http://127.0.0.1:9222
proofkit mission create "测试简历获取" --surface electron --charter .proofkit/charters/resume-core.yml
proofkit mission run <mission-id> --approve
proofkit mission status <mission-id>
proofkit mission evidence <mission-id>
```

This is useful for CI, debugging MCP configuration, and reproducing an agent result locally. CLI, MCP and CI share the same Local Runner, Mission files and run evidence format.
