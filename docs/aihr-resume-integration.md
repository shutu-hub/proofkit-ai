# AIHR Resume Flow Integration

This document records the first project-specific integration target for ProofKit. It is based on the existing AIHR desktop bridge, resume collection service routes and the current resume processing design. ProofKit does not copy AIHR business code into the test engine.

## Verified flow

The current desktop flow has these observable boundaries:

1. Create a collection run with `POST /api/v1/resume-collection/runs`.
2. Generate a deterministic PDF or attachment artifact in the desktop process.
3. Upload it with `POST /api/v1/resume-collection/files`, carrying the run, source channel, candidate and job context.
4. The resume collection service persists the file, extracts text, identifies the candidate, resolves the job relation and creates the downstream assessment when the relation is eligible.
5. Poll read-only state: file detail and text, collection run detail, candidate/job relation, and assessment detail.
6. Finish only when the expected terminal state, identity and billing facts agree.

The important distinction is that an upload response is an acknowledgement, not proof that parsing, candidate identity, job binding or screening completed.

## ProofKit capability boundary

The project integration is now loaded from `.proofkit/integration.mjs` (or the path configured by `integration.path`). The module is trusted repository code and is composed into the same Local Runner lifecycle used by CLI, MCP and CI. It can export capabilities, read-only oracles, and a setup hook that returns cleanup. The Runner supplies a cancellation signal and the configured total run deadline to every run.

The concrete ProofKit workspace now includes a reference AIHR integration at `.proofkit/integration.mjs`. It calls only gateway endpoints and keeps the domain-specific allowlist in the project-owned module. The current capabilities are:

| Capability | Side effect | Evidence returned |
| --- | --- | --- |
| `aihr.createResumeCollectionRun` | test-only write | opaque run ID, source channel and status |
| `aihr.createOnlineResumeIntake` | test-only write | opaque task/workflow/job IDs and status |
| `aihr.waitOnlineResumePipeline` | read | workflow, file, extraction, parse, candidate and assessment states |
| `aihr.readResumeCollectionRun` | read | run status, counts and machine error code |
| `aihr.readResumeFile` | read | file ID/hash and processing statuses |
| `aihr.readWorkflowUsage` | read | immutable workflow facts and stage/result counts |
| `aihr.readBillingUsage` | read | billing usage total and exact workflow-run match count |

Each capability declares an input schema, output schema, environment allowlist, timeout and evidence projection. Raw resume text, cookies, authorization headers and real candidate identifiers never enter the default ProofKit evidence directory. The factory receives ProofKit's schema runtime, so a project integration does not need a hidden `zod` dependency. Integration cleanup runs in reverse registration order after the adapter and project process close; a cleanup error prevents a green verdict.

## Oracle strategy

The first AIHR implementation can use a project-local read-only observer that calls existing gateway endpoints. It should correlate every observation with the ProofKit `runId`, AIHR collection run ID, file ID and client item key. Polling must be bounded and use the service's terminal statuses; arbitrary sleeps are not an oracle.

ProofKit supports a declarative HTTP status oracle with terminal values and JSON Pointer extraction. Its query bindings can use the ProofKit run ID or a sanitized scalar from a completed capability step. The reference integration uses the public gateway projection for workflow, file, candidate and assessment observations, and the starter Charter is parameterized by environment variables for an isolated AIHR test workspace. It must be run against the approved test deployment before it is treated as a release gate.

The minimum acceptance set is:

- The uploaded file belongs to the expected test run and source channel.
- The file has the expected candidate identity or an explicit, explainable identity failure.
- Extraction and parsing reach a terminal state; a UI success message cannot override a backend failure.
- The candidate is bound to the intended job, and the assessment references the same current resume file where that contract requires it.
- A retry does not create a second file, workflow fact or billable screening event for the same idempotency key.
- Billing or usage changes are limited to the declared test scope.

If any one of these facts cannot be observed, the result is `inconclusive` or `blocked`, never an inferred pass.

## Adapter split

The Web/Electron adapter owns platform interaction: navigation, session selection, opening an online resume, downloading or generating the artifact, upload initiation and visible progress. The AIHR integration owns business observation and test data cleanup. The Runner joins both streams through one `runId` and one evidence timeline.

This split lets the same integration be used from the CLI, MCP and CI. MCP must not receive a generic database or shell tool; it can call only the registered capability names with validated inputs. The default MCP profile starts no project command and accepts only loopback or configured test origins.

## Implementation order

1. Run `proofkit init` and fill the generated `.proofkit/integration.mjs` for the AIHR project.
2. Implement `readResumeWorkflowStatus`, `verifyResumeFile`, `verifyPositionBinding` and `verifyBillingLedger` as read-only observers against a dedicated test workspace.
3. Add a bounded polling oracle that writes sanitized JSON evidence and hashes, while preserving request IDs and terminal statuses.
4. Add `seedTestCandidate` and `resetTestScope` only after the test workspace and cleanup contract are explicit.
5. Create one Web smoke and one Electron/CDP smoke for the same charter; compare the final business evidence, not only screenshots.

No new ProofKit database table is needed for this vertical slice. The local run directory, AIHR's existing run/file/workflow/assessment identities and the project integration's idempotency key are sufficient. A durable result index can be considered only after concurrent CI runs require cross-run querying.
