# ProofKit: Product and Architecture Decision

## Positioning

ProofKit is a local, evidence-driven acceptance runner for Web, Electron and Appium-compatible mobile surfaces. A user gives a product goal; ProofKit maps the project, drafts a reviewable Charter, executes real interactions, observes business state, and returns a compact verdict with linked evidence. The differentiator is a verified business outcome across UI, process and backend boundaries. A click receipt or screenshot alone is not success.

## Current implementation (2026-10-10)

| Working | Limit |
| --- | --- |
| Project scan, external test workspace with source binding, Web/Electron Playwright/CDP and W3C WebDriver mobile execution | Project map is structural; it does not infer product invariants; mobile device provisioning and device logs are not managed by the local runner |
| Windows loopback listener process association is recorded before Web/Electron actions; a different Git checkout blocks by default | Process paths do not attest served bytes, and unsupported or ambiguous targets remain explicitly unverified |
| CLI, shared Local Runner, run-level and mission-level MCP interface | Model planning is opt-in and requires an OpenAI-compatible endpoint |
| YAML Charter, validated actions/assertions, Mission task graphs, release Web/Electron replay, and explicit negative/recovery cases | Generated plans still need measured quality and user review for consequential flows; ProofKit executes only cases explicitly declared by the Charter |
| Reviewed route-to-Charter mapping with Web URL and method/origin-scoped API response evidence | Static hints and 2xx responses are candidate-route evidence, not proof of complete workflow or whole-project coverage; entry-point execution remains unmeasured |
| Process health, browser events, named HTTP oracles, bounded polling | Web and Electron smokes exercise an isolated AIHR gateway fixture, including one-sentence MCP catalog selection and a seeded stale job binding; a live AIHR test workspace is still pending |
| Configurable runtime finding classification links page, console and HTTP failures to run evidence | Default record mode reports suspected signals without overriding business proof; a project must opt into fail mode and tune URL filters for its environment |
| Workspace-owned integration module with typed capabilities, oracles and cleanup | The module is trusted local JavaScript; package distribution and version compatibility remain future work |
| Integration preflight runs before setup or surface connection and stores a sanitized gate artifact | Each project must define its own isolation checks; ProofKit cannot prove tenant or data isolation without connector evidence |
| JSONL, artifact hashes, JSON/HTML report, five-state verdict, evidence-linked findings and recoverable Mission attempts | Diagnosis and repair suggestions identify the evidenced business boundary; trusted project Oracles can now provide source-location hints, while automatic source-level inference remains future work |
| Planner benchmark evaluator and fixed quick/core/release runner are available for measuring plan structure without executing a product environment | Benchmark cases currently use the deterministic provider; real model quality, false-pass rate and cost are not yet measured |
| Generated Charters and Mission plans carry planning quality, including assumptions, missing inputs and checked evidence gaps; MCP surfaces these before automatic execution | Confidence is a heuristic, not a measured model accuracy score; older curated Charters remain readable without this metadata |

## User entry path

1. **Zero project code changes:** `proofkit init`, `doctor`, `plan`, `run` against an already running Web app, Electron CDP port or Appium-compatible mobile driver. The CLI is the stable path for CI and repeatable local runs.
2. **AI agent connection:** register the local MCP process against one project. The agent can discover, plan, start, cancel, poll, inspect evidence and replay through the same Runner. MCP is an interface, not a second engine.
3. **Deep business verification:** load a typed capability and Oracle from `<workspaceRoot>/.proofkit/integration.mjs`. Read-only observations expose opaque IDs and safe facts; writes require explicit test scope, idempotency and cleanup. The ordinary AIHR PDF upload integration is the reference connector. A connector can live outside the tested source tree.

Do not require a hosted account, browser extension, general database credentials or a project-specific agent prompt for the first run. Project integrations are optional, but a critical async flow cannot earn a `passed` verdict without a trustworthy business Oracle.

## Core architecture

`CLI / MCP / CI -> Local Runner -> Charter + Project Map -> Surface Adapter + Project Runtime + Domain Capabilities -> Events + Evidence -> Independent Oracles -> Verdict + concise report`

The contracts package owns the Charter, Mission, run, event and verdict schemas. Surface adapters own browser/Electron mechanics and future mobile drivers. Capabilities own project-specific operations. Oracles own assertions about business truth, including bounded polling for asynchronous work. Evidence owns redaction, hashes and links. The Execution Runner joins streams by `runId` and owns each run's verdict; Mission verification aggregates those verdicts and enforces test-level evidence and matrix obligations.

Planning quality is a separate gate before runtime evidence. ProofKit recomputes structural gaps from the validated Charter and bounded Project Map; model confidence cannot establish a pass. A new plan with a missing required Oracle, missing surface assertion, missing release negative case or truncated map cannot automatically start through MCP, and an explicitly executed Mission with a saved planning gap ends `inconclusive`.

## Next three increments

1. **Trustworthy one-sentence planning:** evaluate opt-in generated Charters against the fixed benchmark (`pnpm benchmark:planner`), add a review gate for consequential actions, and report what the planner could not infer. Model text never executes shell, SQL or JavaScript directly.
2. **AIHR vertical proof:** the checked-in ordinary-upload Charter now runs through real Web and Electron adapters against a loopback gateway fixture. Both adapters pass the success path and detect a seeded stale job binding with an Oracle artifact linked to a confirmed product Finding, Diagnosis and RepairSuggestion. Next, run the same Charter against a real isolated AIHR workspace and compare the terminal facts across surfaces.
3. **Trust and repeatability:** isolated browser profiles, retry/idempotency checks, evidence-safe diagnostics and a first-failure report with likely owner and suggested repair backed by observed facts. Cancellation, total run deadline, release replay, safe recovery of interrupted read-only tasks, and explicit negative/recovery case execution are now part of the runner; profile isolation and retry classification remain open.

The mobile adapter uses the W3C WebDriver contract first so Appium-compatible Android, iOS and hybrid drivers can share the Runner/verdict model. Maestro or device-cloud provisioning can be added as separate adapters later. Keploy-style traffic replay can provide deterministic backend fixtures later. Neither changes the Runner/verdict model.

## Quality gate

A release claim such as “tests a whole project” requires measured coverage of discovered workflows, repeat runs without flaky verdicts, and seeded defects found with evidence. Report coverage gaps explicitly. Unknown business semantics, unavailable credentials or an unfinished asynchronous workflow produce `blocked` or `inconclusive`, not a green result.
