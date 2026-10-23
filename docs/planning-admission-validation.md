# Planning admission validation

Date: 2026-10-23

## Change

ProofKit now applies a pre-execution admission check in `MissionAgent`. A plan with an explicit executable evidence gap is persisted as `blocked` before any Mission tool is invoked. The blocking set is deliberately bounded to:

- `business-oracle`
- `surface-assertion`
- `surface-selector`
- `surface-page`

Coverage-only gaps such as `project-map-truncated` and `project-workflow-coverage` remain visible, but do not suppress execution of an otherwise declared Charter. They can still make the final result `inconclusive`.

Planner revalidation preserves only the bounded machine-generated gap vocabulary. Arbitrary provider text is not promoted into an execution gate.

## Acceptance evidence

The same admission contract is now enforced at all three developer-facing entry points:

- `LocalRunnerService.start({ intent })` rejects before creating a Run.
- CLI `proofkit run <intent>` returns `needs-input`, `testVerdict=not-asserted`, `executionStarted=false` and exit code 2 instead of a stack trace.
- MCP `run_test` returns readiness/next-action metadata and does not call `startMission` when the plan is not ready. A real `LocalRunnerService` + MCP in-memory transport regression also verifies that no `.proofkit/runs` directory is created for an incomplete direct intent.
- CLI direct intent also preserves `needs-observation` as a structured receipt with the approved observation request and continuation pins; it does not turn a planning pause into a product failure.
- Missing OpenAI-compatible planner configuration is returned as `planner-not-ready` with `testVerdict=not-asserted`, `executionStarted=false` and next actions `configure_planner`, `plan_test`, `run_test`; it is not reported as a product test failure.
- CLI `proofkit plan` and `proofkit mission create` use the same planner-not-ready response instead of exposing the raw provider configuration exception.

- `packages/agent/src/index.test.ts`: 32 tests passed, including an approved Mission with `business-oracle` that invoked zero tools and recorded an evidence-boundary `firstFailure`.
- `packages/local-runner/src/local-runner.test.ts`: 36 tests passed, including direct natural-language Run admission, exact preflight Charter reuse, and the real openai-compatible planner-not-ready path.
- `packages/local-runner/src/workspace.test.ts`: 15 tests passed, including the external-workspace path and no Web connection for the blocked Mission.
- `packages/local-runner/src/release-suite.test.ts`: 31 tests passed; coverage gaps continue to execute and remain auditable as `inconclusive` where appropriate.
- Full workspace command `pnpm test` passed. The latest workspace run included 680 LocalRunner tests, 49 CLI tests, 62 MCP tests, and 17 Node integration tests, in addition to the other package suites.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed during this validation cycle.
- Cross-entry targeted regression: 36 LocalRunner tests, 12 CLI planning tests, 53 MCP tool tests, and 37 evidence-report tests passed; planner-not-ready is covered in CLI `plan`, `run`, `mission create` and MCP paths.
- Planner configuration readiness regression: missing provider configuration returns `planner-not-ready` with `configure_planner` guidance in both CLI and MCP, without claiming a product verdict.
- The planner-readiness path is included in the CLI/MCP targeted regressions; package boundaries remain intact because MCP consumes the re-exported LocalRunner error type.

## Boundary

This proves the admission invariant and its compatibility with existing evidence and coverage behavior. It does not prove autonomous planning quality on unfamiliar applications. The planner provider remains environment-dependent, and a completed Mission without an executable planning gap can still become `blocked` or `inconclusive` because of authentication, target binding, runtime failure, missing independent reads, or evidence-integrity failure.
