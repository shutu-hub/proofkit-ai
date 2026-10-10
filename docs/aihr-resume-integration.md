# AIHR Resume Flow Integration

This document records the first project-specific integration target for ProofKit. It is based on the existing AIHR desktop bridge, resume collection service routes and the current resume processing design. ProofKit does not copy AIHR business code into the test engine.

## Verified flow

The default AIHR flow for ProofKit is the ordinary PDF upload path. The current desktop flow has these observable boundaries:

1. Create a collection run with `POST /api/v1/resume-collection/runs`.
2. Generate a deterministic PDF or attachment artifact in the desktop process.
3. Upload it with `POST /api/v1/resume-collection/files` as multipart form data, carrying the run, source channel, candidate and job context.
4. The resume collection service persists the file, extracts text, identifies the candidate, resolves the job relation and creates the downstream assessment when the relation is eligible.
5. Poll read-only state: file detail and text, collection run detail, candidate/job relation, and assessment detail.
6. Finish only when the expected terminal state, identity and billing facts agree.

The important distinction is that an upload response is an acknowledgement, not proof that parsing, candidate identity, job binding or screening completed.

## ProofKit capability boundary

The project integration is loaded from `<workspaceRoot>/.proofkit/integration.mjs` (or the path configured by `integration.path`). The module is trusted local test-workspace code and is composed into the same Local Runner lifecycle used by CLI, MCP and CI. It can export capabilities, read-only oracles, and a setup hook that returns cleanup. The Runner supplies a cancellation signal and the configured total run deadline to every run.

The ProofKit repository includes a reference AIHR integration at `.proofkit/integration.mjs`, with its sibling `.proofkit/aihr-manual-intake.mjs`. Copy both files to the external workspace's `.proofkit/` directory; the entry module imports the sibling even when a different AIHR Oracle is selected. No ProofKit file is needed in the AIHR repository. The connector calls only gateway endpoints and keeps the domain-specific allowlist in the workspace-owned module. The current capabilities are:

| Capability | Side effect | Evidence returned |
| --- | --- | --- |
| `aihr.createResumeCollectionRun` | test-only write | opaque run ID, source channel and status |
| `aihr.uploadResumeFile` | test-only write | opaque file ID, file hash, run ID, idempotency key and initial statuses |
| `aihr.waitResumeCollectionPipeline` | read | extraction, parsing, candidate, job relation, assessment and workflow facts |
| `aihr.createOnlineResumeIntake` | test-only write | opaque task/workflow/job IDs and status |
| `aihr.waitOnlineResumePipeline` | read | workflow, file, extraction, parse, candidate and assessment states |
| `aihr.readResumeCollectionRun` | read | run status, counts and machine error code |
| `aihr.readResumeFile` | read | file ID/hash and processing statuses |
| `aihr.readWorkflowUsage` | read | immutable workflow facts and stage/result counts |
| `aihr.readBillingUsage` | read | billing usage total and exact workflow-run match count |

Each capability declares an input schema, output schema, environment allowlist, timeout and evidence projection. The connector projects opaque business IDs and selected scalar facts, excluding resume text, contact details, cookies and authorization headers. Surface screenshots and snapshots can still retain visible page content, so use synthetic inputs. The factory receives ProofKit's schema runtime, so a project integration does not need a hidden `zod` dependency. Integration cleanup runs in reverse registration order after the adapter and project process close; a cleanup error prevents a green verdict.

Both pipeline wait capabilities use one monotonic deadline across polling intervals, HTTP requests and response bodies. `maxWaitMs` expiring returns `passed: null` and `terminal: false`; evidence and `observationCount` retain only fully completed observation rounds. A partially read file/relation/assessment round cannot supply a terminal verdict. User cancellation rejects with the original signal reason, including a non-Error reason, and releases the polling timer and listeners. Observed gateway errors still propagate as errors. These capabilities bound their own wait; the independent Oracle performs a separate read under the Runner's signal and total deadline.

## Oracle strategy

The first AIHR implementation uses a workspace-owned read-only observer that calls existing gateway endpoints. It correlates every observation with the ProofKit `runId`, AIHR collection run ID, file ID and client item key. Polling is bounded and uses service terminal statuses; arbitrary sleeps are not an oracle.

ProofKit supports a declarative HTTP status oracle with terminal values and JSON Pointer extraction. Its query bindings can use the ProofKit run ID or a sanitized scalar from a completed capability step. The reference integration uses the public gateway projection for workflow, file, candidate and assessment observations. `.proofkit/charters/aihr-resume-upload.yml` is the default ordinary-upload Charter; `.proofkit/charters/aihr-online-resume.yml` remains a compatibility Charter for the online intake path. Both are parameterized by environment variables for an isolated AIHR test workspace and must be run against the approved test deployment before they are treated as release gates.

The minimum acceptance set is:

- The uploaded file belongs to the expected test run and source channel.
- The file has the expected candidate identity or an explicit, explainable identity failure.
- Extraction and parsing reach a terminal state; a UI success message cannot override a backend failure.
- The candidate is bound to the intended job, and the assessment references the same current resume file where that contract requires it.
- A retry does not create a second file, workflow fact or billable screening event for the same idempotency key.
- Billing or usage changes are limited to the declared test scope.

If any one of these facts cannot be observed, the result is `inconclusive` or `blocked`, never an inferred pass.

### Assessment and identity gates

The current AIHR domain defines evaluation states `running/success/failed` and task states `pending/processing/retry_wait/success/failed/dead/cancelled`. When assessment completion is required, both `assessment.status=success` and `assessment.task_status=success` must be observed. `assessment_worker_service.go` persists the successful evaluation before completing usage recording and marking its task successful; accepting either state alone would report success while required worker work is retrying. A failed evaluation or a `failed/dead/cancelled` task is a failed observation. Pending, retrying or missing states remain inconclusive.

The connector reads assessment detail rather than trusting green workflow/file summary fields. Job relation facts must identify the same file, job and candidate; required assessment facts must also include an assessment ID and the same file/job/candidate. Missing identities cannot pass. The wait Capability and independent Oracle share the acceptance rules but perform separate reads; their evidence retains the identity and status facts used for each conclusion in `oracle-N-source.json`.

### Online-stage acceptance scope

`aihr.onlineResumePipeline` verifies the online-resume stage, not the entire conversation and attachment lifecycle. It additionally correlates the workflow ID, conversation, job, workflow online-file ID, returned file ID and conversation/file candidate IDs. A `retryable_error` phase or a nonempty workflow error code alone does not prove terminal failure. Valid online-stage phases are `wait_online_screening`, `wait_attachment`, and `terminated`; termination requires the authoritative relation stage `screen_reject` and successful technical processing.

Evidence declares `acceptanceScope: online-resume`. Its `terminal` flag means this acceptance has a true/false conclusion; it does not mean the conversation is complete. In particular, `wait_online_screening` can satisfy a declared assessment-completion check while later conversation actions remain open.

AIHR legally replaces current relation and assessment file facts during attachment processing. An observed `attachment_resume_file_id` or `completed` phase therefore sets `scopeSuperseded: true` and returns inconclusive without waiting for the online file to become current again. It does not confirm an obsolete-file defect or supply a product repair suggestion. Missing attachment identity in a completed workflow also cannot establish the online stage retrospectively. A separate attachment/lifecycle Charter with historical or phase-specific evidence is still required.

Use an isolated candidate/job and pause attachment advancement during online acceptance. A concurrent upload before the workflow exposes an attachment identity cannot yet be distinguished from an incorrect current-file binding by these latest-state endpoints. Billing idempotency and full lifecycle coverage remain separate acceptance obligations.

### Manual candidate intake

The separate `aihr.manualCandidateIntake` Oracle follows the existing manual
entry flow: active-job validation, file save with `manual_upload`, candidate
creation/version append, explicit job binding, optional talent-pool insertion,
and forced extraction enqueue. It requires neither a collection run nor an
online workflow. An enqueue error can return HTTP 503 after business objects
have been created; this API provides no `client_item_key` contract, atomic
rollback or proved zero-write retry guarantee.

Use a single synthetic file with `setInputFiles`, then `captureResponse` for
the exact POST `/api/v1/resume-collection/candidate-intakes`. Configure these
response projections with `type: id`:

| Capture field | JSON Pointer |
| --- | --- |
| `fileId` | `/data/resume_file_id` |
| `candidateId` | `/data/candidate_id` |
| `versionId` | `/data/resume_version_id` |
| `jobId` | `/data/job_id` |
| `relationId` | `/data/job_candidate_id` |

For a Charter whose file selection and capture are its second and third
actions, configure:

```yaml
oracles: [aihr.manualCandidateIntake]
metadata:
  aihrManual:
    fileStepId: step-002
    captureStepId: step-003
    jobId: $env:AIHR_PROOFKIT_JOB_ID
    maxWaitMs: 60000
    pollIntervalMs: 1000
```

Actual page entry, controls and a positive assertion must be discovered from
the running AIHR page; this metadata is not a ready-made live UI Charter.
The Oracle binds the passed file step's SHA-256 to a passed, unique,
action-window-associated POST response with status 200/201. It rejects missing
or inconsistent action receipts before any business GET. Replays capture new
submission IDs and preserve the original fixture identity.

All five readers use captured identities, never IDs inferred from another
reader's response:

| Gateway resource | Required facts |
| --- | --- |
| `GET /resume-collection/files/:fileId` | file ID, SHA-256, `manual_upload`, candidate ID, extraction and parse state |
| `GET /candidates/:candidateId` | candidate ID and `profile.current_resume_version_id` |
| `GET /candidates/:candidateId/resume-versions` | exactly one captured version, file ID, SHA-256 and `is_current` |
| `GET /jobs/:jobId/candidates/:candidateId` | relation ID, job/candidate IDs and current file/version |
| `GET /assessments/jobs/:jobId/candidates/:candidateId` | assessment ID, job/candidate/file/relation IDs, evaluation and task state |

Paths above are relative to the configured `/api/v1` gateway base. Candidate
detail does not expose the current file or SHA; those come from the version
reader. Success requires extraction `done`, parse `matched`, and both
assessment `status` and `task_status` equal to `success`, with all identities
and digests present and agreeing. While parsing is pending, an older
assessment does not prove a defect. Missing identities, pending/retry states,
gateway errors and incomplete observation rounds remain inconclusive. A
reader's status or digest without its own identity cannot confirm a defect.

AIHR `AppendResumeVersion` legally reuses the version ID for an equal SHA and
preserves source history. A version's historical `source_channel=boss` can
therefore be valid. It also updates the version's file binding: another
upload can change the file without changing the version ID. A changed
version file or current version ends this scope as inconclusive, rather than
confirming an obsolete-file defect. An evidenced wrong digest remains a
failure. The five reads are non-atomic; use an isolated candidate/job and
prevent concurrent uploads. Latest-state APIs do not prove historical
terminal state, complete business causality, billing or cleanup.

The preflight requires `local`/`test`, a `proofkit:<scope>` test scope,
enterprise/workspace/user actor headers and a positive target job ID. These
are configuration checks, not proof of deployment isolation or valid
credentials. A manual capture triggers preflight even at `quick`. The
connector does not automatically delete business records; provisioning and
cleanup must use the target environment's approved test-scope procedure.

`pnpm test:smoke:manual-intake` uses the actual copied connector, real Chrome,
an isolated Electron profile and an AIHR-shaped loopback fixture through MCP.
Set `PROOFKIT_ELECTRON_PATH` to an installed Electron executable. Its 28
Missions cover fresh IDs, eventual worker success, three seeded digest or
relation defects with six repair replays, pending/retry/superseded states,
same-SHA version rebinding and unavailable readers. It checks source
immutability and unselected response fields. This validates the connector
and execution contract; live AIHR UI, parsing workers and billing acceptance
remain open.

## Adapter split

The Web/Electron adapter owns platform interaction: navigation, session selection, opening an online resume, downloading or generating the artifact, upload initiation and visible progress. The AIHR integration owns business observation and test data cleanup. The Runner joins both streams through one `runId` and one evidence timeline.

An AIHR integration may also be loaded for a surface-only quick check. When a quick Charter contains no AIHR Capability action, AIHR business Oracle or manual intake capture, the connector records a passed `preflight.json` with `integrationRequired: false` and does not require `AIHR_PROOFKIT_TEST_SCOPE` or a gateway endpoint. Core and release business Charters, and any Charter that names an AIHR Capability/Oracle or captures manual intake, continue through the isolation and scope preflight before the surface is connected.

This split lets the same integration be used from the CLI, MCP and CI. MCP must not receive a generic database or shell tool; it can call only the registered capability names with validated inputs. The default MCP profile starts no project command and accepts only loopback or configured test origins.

## Implementation order

1. Run `proofkit init --root <AIHR-source> --workspace <external-test-workspace>`, then copy or adapt both `.proofkit/integration.mjs` and `.proofkit/aihr-manual-intake.mjs` in that external workspace.
2. Use the ordinary upload Charter to validate `collection_run → file → extract → parse → candidate → job → assessment`.
3. Add or refine read-only observers for billing and retry/idempotency facts against a dedicated test workspace.
4. Add `seedTestCandidate` and `resetTestScope` only after the test workspace and cleanup contract are explicit.
5. Create one Web smoke and one Electron/CDP smoke for the same Charter; compare the final business evidence, not only screenshots.

The current ProofKit workspace has validated the ordinary upload integration with isolated HTTP mocks. A live AIHR workspace, real Electron session and production-like worker chain are still required before claiming end-to-end release coverage.

No new ProofKit database table is needed for this vertical slice. The local run directory, AIHR's existing run/file/workflow/assessment identities and the project integration's idempotency key are sufficient. A durable result index can be considered only after concurrent CI runs require cross-run querying.
