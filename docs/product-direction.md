# ProofKit: Product and Architecture Decision

## Positioning

ProofKit is a local, evidence-driven acceptance runner for Web and Electron. A user gives a product goal; ProofKit maps the project, drafts a reviewable Charter, executes real interactions, observes business state, and returns a compact verdict with linked evidence. The differentiator is a verified business outcome across UI, process and backend boundaries. A click receipt or screenshot alone is not success.

## Current implementation (2026-10-09)

| Working | Limit |
| --- | --- |
| Project scan, local config, Web/Electron Playwright/CDP execution | Project map is structural; it does not infer product invariants |
| CLI, shared Local Runner, run-level and mission-level MCP interface | Model planning is opt-in and requires an OpenAI-compatible endpoint |
| YAML Charter, validated actions/assertions, Mission task graphs, and release Web/Electron replay | Generated plans still need measured quality and user review for consequential flows; negative paths are not yet automatic |
| Process health, browser events, named HTTP oracles, bounded polling | Web and Electron Local Runner smokes exercise the AIHR Charter against an isolated gateway fixture, including a seeded stale job binding; a live AIHR test workspace is still pending |
| Project-owned integration module with typed capabilities, oracles and cleanup | The module is trusted local JavaScript; package distribution and version compatibility remain future work |
| JSONL, artifact hashes, JSON/HTML report, five-state verdict, evidence-linked findings and recoverable Mission attempts | Diagnosis and repair suggestions identify the evidenced business boundary, but source-level ownership and code locations are not inferred yet |

## User entry path

1. **Zero project code changes:** `proofkit init`, `doctor`, `plan`, `run` against an already running Web app or an Electron CDP port. The CLI is the stable path for CI and repeatable local runs.
2. **AI agent connection:** register the local MCP process against one project. The agent can discover, plan, start, cancel, poll, inspect evidence and replay through the same Runner. MCP is an interface, not a second engine.
3. **Deep business verification:** load a project-local typed capability and Oracle from `.proofkit/integration.mjs`. Read-only observations expose opaque IDs and safe facts; writes require explicit test scope, idempotency and cleanup. The ordinary AIHR PDF upload integration is the reference connector.

Do not require a hosted account, browser extension, general database credentials or a project-specific agent prompt for the first run. Project integrations are optional, but a critical async flow cannot earn a `passed` verdict without a trustworthy business Oracle.

## Core architecture

`CLI / MCP / CI -> Local Runner -> Charter + Project Map -> Surface Adapter + Project Runtime + Domain Capabilities -> Events + Evidence -> Independent Oracles -> Verdict + concise report`

The contracts package owns the Charter, run, event and verdict schema. Surface adapters own browser/Electron mechanics and future mobile drivers. Capabilities own project-specific operations. Oracles own assertions about business truth, including bounded polling for asynchronous work. Evidence owns redaction, hashes and links. The Runner joins all streams by `runId`; it is the only verdict authority.

## Next three increments

1. **Trustworthy one-sentence planning:** evaluate opt-in generated Charters against a fixed Web/Electron benchmark, add a review gate for consequential actions, and report what the planner could not infer. Model text never executes shell, SQL or JavaScript directly.
2. **AIHR vertical proof:** the checked-in ordinary-upload Charter now runs through real Web and Electron adapters against a loopback gateway fixture. Both adapters pass the success path and detect a seeded stale job binding with an Oracle artifact linked to a confirmed product Finding, Diagnosis and RepairSuggestion. Next, run the same Charter against a real isolated AIHR workspace and compare the terminal facts across surfaces.
3. **Trust and repeatability:** isolated browser profiles, retry/idempotency checks, evidence-safe diagnostics and a first-failure report with likely owner and suggested repair backed by observed facts. Cancellation, total run deadline, release replay, and safe recovery of interrupted read-only tasks are now part of the runner; profile isolation, negative-path execution, and retry classification remain open.

Mobile follows once these contracts survive the Web/Electron business slice. Maestro is the initial mobile adapter candidate; Appium covers cases Maestro cannot. Keploy-style traffic replay can provide deterministic backend fixtures later. Neither changes the Runner/verdict model.

## Quality gate

A release claim such as “tests a whole project” requires measured coverage of discovered workflows, repeat runs without flaky verdicts, and seeded defects found with evidence. Report coverage gaps explicitly. Unknown business semantics, unavailable credentials or an unfinished asynchronous workflow produce `blocked` or `inconclusive`, not a green result.
