/** Portable Agent Skills content; the host supplies reasoning, MCP supplies execution. */
export const PROOFKIT_TEST_SKILL = `---
name: proofkit-test
description: Test Web, Electron or mobile product workflows with ProofKit MCP, independent business checks and saved evidence. Use for feature acceptance, core-module testing, release regression and verification after a fix.
---

# ProofKit testing

Use the host's source-reading and reasoning tools to understand the request.
Use ProofKit to execute the test and obtain its evidence-backed verdict.
Keep test configuration, Charters, connectors and fixtures in the external
ProofKit workspace. Read the application source to trace a workflow; adding
ProofKit code to the application's business modules is unnecessary.

If no bound ProofKit server is available, use proofkit agent setup with the
actual harness, source root and external workspace. Register the emitted native
MCP configuration through that host's supported workflow, then confirm tools
are available. The setup export is not a connection check or a product test.
When the source is verified as AIHR, explicitly select --template aihr on the
first setup to install its reviewable connector and example Charters before the
generic starter is created. Review this trusted connector before a separate
connection check or host registration. These examples are not registered tests;
inspect and adapt their UI actions, assertions and business readers. If a
workspace already contains a generic or custom connector, preserve it and use
a fresh external workspace or deliberately merge the reference after review.

## Resolve the request

Preserve the user's requested feature, platform, test intensity and acceptance
scope. Use core when no intensity is specified. Quick is the shortest
observable path; core also requires independent business facts; release runs
the declared Web/Electron matrix, replay and declared negative scenarios.
Do not downgrade the level to obtain a passing result. Whole-project requests
must retain coverage: project, even when only some scenarios are available.

Call inspect_test_scope for the intended surface and level. Check its
projectRoot against the checkout the user asked to test; select the matching
ProofKit server when multiple bindings exist. A focus is a literal module or
source-path substring, not the full natural-language sentence. The returned
routes are static candidates; counts, omissions and truncation are scope limits.
Read planningReadiness before selecting a scenario. catalog-ready means only a
saved plan passed structural checks; it is not runtime readiness. If a quick
Charter matches a core request, keep core and author or register core proof.
For inspection-incomplete, refine the literal focus or raise the bounded limit
before concluding no plan exists. A source-focus-unresolved gap means the
literal term missed retained source hints, not that the feature is absent.
An oracle-name-unmatched gap likewise requires inspecting the registered
readers; it does not prove that no business reader applies.
Review workspaceCandidates when the external workspace has unregistered
Charter files. These are read-only, bounded hints, including structural issue
codes; they are never catalog-ready or executable by discovery alone. A
fallback-unmatched selection means no candidate literally matched the focus.
Inspect the Charter and source flow, and repair missing assertions or Oracles.
After review, use run_test with the relative charterPath exactly as returned
by workspaceCandidates and the exact charterSha256 from the same scope
inspection, or register a reusable catalog entry. Do not convert the candidate
path to an absolute filesystem path. A digest
mismatch means the file changed: inspect it again before planning. Do not
infer core proof from an
unregistered file or lower the requested level to reuse a quick example.
The candidate file owns its actions, Oracles, mode and side-effect policy;
do not combine charterPath with charter, charterId, suiteId, url, expect,
oracleNames, mode or sideEffectPolicy tool arguments. Keep the requested
intent, level, surface and coverage in the call.
Treat write-opt-in-required and mcp-workspace-policy-conflict as execution
prerequisites. Do not alter a workspace policy or authorize writes solely to
clear a candidate hint; confirm isolated test data and the user's scope first.

## Reuse or author a scenario

Prefer an eligible, plan-ready catalog Charter or explicit release suite that
matches the requested behavior. Use charterId or suiteId when aliases are
ambiguous. Plan readiness does not prove login, fixtures or running services.

Use inspect_test_environment to observe configured endpoints before attachment.
For Web/Electron it checks HTTP/CDP and applicable source association; for mobile
it checks the bounded WebDriver /status ready value without opening a device
session. Resolve its concrete gaps before dependent actions.
MCP does not start the configured application command; use the project's
documented development startup workflow when authorized. Use inspect_surface
when controls or readiness are unknown, then inspect the owning source and
API contract. Configure readyWhen for a real visible prerequisite if needed.
These observations return not-asserted and cannot establish a product pass.

If the catalog has no suitable scenario, use a reviewed digest-pinned workspace
candidate or submit a structured Charter to run_test. Read [Charter authoring](references/charter-authoring.md)
for the structured path.
Include a positive surface assertion and, for core/release, an independent
business Oracle for the expected terminal result. If this action returns an ID
and the project exposes a suitable read-only status API, declare a bounded
httpOracles reader in the Charter. Bind the current captured ID to its query,
verify the independent response's ID and terminal state, and use the Oracle's
name in oracles. For authenticated or multi-entity checks, use a trusted
workspace connector. When no valid reader exists, report the missing contract;
do not invent an Oracle name or infer backend success from a toast. Observe
test identities and isolation before write actions.
Use authorization already given by the user. Missing access or write permission
is a concrete prerequisite, not a reason to weaken the test.

## Execute and retain evidence

Call run_test with the original intent, resolved level, surface and coverage,
plus the selected catalog ID or validated Charter. Inspect readiness.missing,
planning and next when it does not start. Correct supported plan gaps rather
than forcing an evidence-deficient plan through approval.
For a whole-project request blocked by project-workflow-coverage, inspect the
external workflow inventory and report that full-project acceptance is not
established. Do not launch a separate declared-scope Mission as a substitute
or attach a declared Mission's report to the project Mission ID. Create a
reviewed inventory only when its workflow list and source links are supported;
static routes alone cannot prove that list is complete. A newly created core or
release project Mission can be admitted only with an externally trusted signed
review, a complete candidate scan without exclusions and an exact Charter ×
surface matrix. After execution, use the audited testVerdict and
workflowReviewAudit.scope. A pass is limited to reviewed source workflows;
quick checks and previously saved Missions cannot gain this pass later.

Keep the returned missionId. Call await_test_result for that same Mission. Its
bounded wait returns a terminal summary with current evidence integrity, a
still-running receipt, or a concrete next action if no owner is running. Repeat
the wait for a still-running Mission; read get_mission_evidence after termination
for detailed findings and links. Never restart merely because a wait timed out.
The running receipt reports settled tasks and the saved execution deadline.
If remainingExecutionMs reaches zero while an owner is still active, it may be
finishing cancellation and cleanup; keep waiting on that Mission ID until the
owner settles. Progress is not a product verdict.
Cancelling the wait does not cancel the Mission.
When run_test or await_test_result reports awaiting-approval with readiness.ready
false, no product test ran. Report testVerdict as not-asserted and explain the
missing planning proof. Do not label it blocked or failed, even if a planning
report was generated. Follow the returned next actions; do not approve an
evidence-deficient Mission.
Cancel with cancel_mission if the user requests a stop. Do not repeat a write
scenario blindly after interruption; inspect saved status and resources first.
An interrupted task without its original tool side-effect receipt and recovery
key, or whose declaration/key changed across restart, requires review before
any retry. A connector recovery key depends on its declared version and test
context; it cannot prove unchanged code. Review the connector and affected
resources before choosing any new run.
inspect_run_resources is observational; recover_run_resources requires a
recoverable orphan, the original connector and existing write authorization.
Resource recovery does not change the original product verdict.

## Present and verify the result

Use get_mission_evidence.testVerdict and the report path for the user-facing
outcome. The separate verdict field is the saved historical result. Give the tested scope
and level, a compact outcome, the first actionable failure and its evidence,
plus any missing acceptance obligations. Distinguish failed business facts from
blocked access/environment, cancelled work and inconclusive evidence. A console
error alone is not a confirmed product defect. Cite evidence for a diagnosis;
inspect the relevant source before proposing a change.
For release Missions, inspect summary.replayConsistency. A divergent primary
and replay verdict is an observed difference to investigate, not proof of
flakiness. An unverified pair may lack a Run, a replay source link or hashed
evidence. Check the Run links and current evidence integrity before reporting
the saved comparison.
Check get_mission_evidence.evidenceIntegrity.status before presenting a saved
confirmed finding or repair as currently supported. "degraded" means one or
more presented references or confirmed findings lack verifiable bytes;
"partial" means the bounded result omitted some rows, findings or references;
read acceptanceEvidenceIntegrity for the full Mission reference audit and
claim current support only when every cited finding and repair fact verifies.
"no-evidence" cannot support a product claim. The saved verdict is historical,
and "intact" covers only the presented references, not all project workflows.
Check summary.scope.sourceStability and sourceFreshness before treating a saved
pass or defect as current. A changed Git source during or after execution, or
an unavailable recheck after a complete final fingerprint, makes testVerdict
inconclusive. An unverified fingerprint does not attest the current checkout;
the result still describes the tested point in time.
Check get_mission_evidence.proofClassification as well. If it is "unverified",
saved Oracle results lack explicit business/HTTP-contract classification or a
referenced Run could not be read; describe the verdict as historical and rerun
the affected scenarios before claiming current business proof. "explicit" only
means Oracle kinds were recorded; still check the Mission's business facts,
coverage and cited evidence.
For a saved pass whose required proof classification is unverified or whose
Mission evidence is degraded, absent or beyond the audit limit, testVerdict is inconclusive and
testVerdictReason explains the rerun needed. Do not report the saved pass as a
current acceptance result. A compact partial report can retain a pass only when
the full Mission evidence audit is intact.
For a saved failure, do not claim a current product defect when its cited
evidence is missing, changed or lacks an explicitly classified failing business Oracle.
In that case testVerdict is inconclusive while verdict remains historical.

For an authorized fix, review the original Mission's scope and side effects,
then call replay_mission with approve=true to authorize this new execution.
Without that flag, a replay that requires approval remains awaiting-approval;
use approve_test_plan and start_mission after review. Preserve the original
scope and fixture bytes, then compare_missions after the replay finishes.
Report verified-in-scope only when the comparison says so. A different scenario
or passing page cannot certify the original defect or the entire project.
For variability investigation, gather three to five separately authorized
direct-replay Missions and call analyze_mission_stability with their IDs in
execution order. A variable-outcome result is evidence of changed outcomes,
not a flaky-test root-cause diagnosis. Do not reuse one Run as several samples.
When repeated execution is requested, create_mission_repeat from an evidenced
terminal Mission, then advance_mission_repeat one slot at a time and await its
result. Use get_mission_repeat_status after reconnecting. Approve each
interactive slot separately; a previous approval never authorizes the series.
Treat an inconclusive series or changed source as a stopped investigation.
Read the comparison again when reporting: candidateSourceFreshness changed or
unavailable withdraws a saved repair or reproduced-defect claim to inconclusive.
historicalStatus describes the saved result, not the current checkout.
Mobile inspect_surface returns a bounded driver-label snapshot and evidence with
testVerdict not-asserted; it does not provide validated selector hints or a
device-backed acceptance claim. File selection and response capture currently
support Web/Electron only. Mobile click/fill requires one visible element at
action time; an ambiguous or unverifiable locator is inconclusive. Mobile
business testing still needs a real-device
acceptance run before claiming device coverage.
`;

export const PROOFKIT_CHARTER_AUTHORING = `# Author a ProofKit Charter

Read the live run_test input schema and inspect_test_scope capability hints.
The server's Zod validation is authoritative. Keep the Charter in the external
workspace; use an inline Charter for one Mission, or save a proven scenario in
the workspace catalog for reuse. A model confidence score cannot prove readiness.

## Minimal read-only core example

Replace the URL, text and Oracle name with verified project contracts. This
example works only after resume.terminal has been registered in the workspace.

\`\`\`json
{
  "intent": "Verify the resume page and its completed processing result",
  "surface": "web",
  "level": "core",
  "coverage": "declared",
  "charter": {
    "intent": "Verify the resume page and its completed processing result",
    "level": "core",
    "sideEffectPolicy": "deny",
    "actions": [{ "kind": "goto", "url": "http://127.0.0.1:5173/resumes" }],
    "assertions": [{ "kind": "text-visible", "text": "Resumes" }],
    "oracles": ["resume.terminal"]
  }
}
\`\`\`

The page text must prove that the intended UI loaded. Absence of an error alone
is insufficient. The Oracle independently reads the object tested in this Run,
checks its identity and required terminal state, and returns source facts.

## Interactions and current-submission identity

Use selectors obtained from the actual page and source; a hint can become stale
after navigation. Web/Electron recheck uniqueness for click, fill, press and
setInputFiles. fill can use an environment-variable reference instead of saving
a credential value. Use synthetic inputs; screenshots can contain visible data.

Interactive actions require sideEffectPolicy: allow in the Charter and
policies.sideEffects: allow in workspace config. Write Capabilities and declared
write setup additionally require process-level operator opt-in. Setting a
Charter field never supplies that authorization or proves test-data isolation.

For uploads, prepare files under .proofkit/fixtures/ in the workspace and use
setInputFiles with a unique file-input selector, including a hidden input when
appropriate. It accepts 1–10 files and at most 20 MiB total, and saves input
hashes. Selection alone does not prove submission or processing.

Use captureResponse around the actual submit click or keypress when an API
returns the new object's identity. Declare its exact endpoint, method, accepted
statuses and selected JSON Pointer scalar fields. An independent Oracle must
query those IDs and check reader identity before waiting for terminal state.
For a simple local read-only status API, define httpOracles in the Charter;
the current response binding, identity matchPointer and terminal statusPointer
are required. Read the example below. MCP only accepts loopback Oracle URLs.
The inline reader performs bounded GET polling and cannot supply credentials,
custom headers or arbitrary code. Use a workspace connector for those needs
or for multiple independent business entities.
If the request starts later, set requestStartTimeoutMs while keeping timeoutMs
large enough for the full action. If an optional confirmation dialog may appear,
declare one followUp: { kind: clickIfVisible, selector, waitMs } using a reviewed
unique visible control. The same listener covers both clicks and saves whether
the follow-up was clicked or skipped. A late or ambiguous dialog is not a pass.
Multiple matching requests, missing capture or missing reader facts are
inconclusive. Do not reuse an older successful object as proof of this action.

\`\`\`json
{
  "intent": "Test this resume submission and its terminal state",
  "surface": "web",
  "level": "core",
  "charter": {
    "intent": "Test this resume submission and its terminal state",
    "level": "core",
    "sideEffectPolicy": "allow",
    "actions": [
      { "kind": "goto", "url": "http://127.0.0.1:5173/resumes" },
      { "kind": "captureResponse", "name": "resume-created",
        "trigger": { "kind": "click", "selector": "#submit-resume" },
        "response": { "url": "http://127.0.0.1:5173/api/v1/resumes", "method": "POST",
          "statuses": [201], "fields": { "fileId": { "pointer": "/data/fileId", "type": "id" } } } }
    ],
    "assertions": [{ "kind": "text-visible", "text": "Submission accepted" }],
    "oracles": ["current-resume-status"],
    "httpOracles": [{ "name": "current-resume-status",
      "url": "http://127.0.0.1:5173/api/v1/resume-status",
      "query": { "fileId": { "source": "response", "stepId": "step-002",
        "field": "fileId", "matchPointer": "/data/fileId" } },
      "statusPointer": "/data/state", "successValues": ["complete"],
      "failureValues": ["failed"], "deadlineMs": 30000 }]
  }
}
\`\`\`

Replace endpoints, selectors, pointers and terminal values with observed
project contracts. The page's positive assertion and workspace side-effect
policy still apply. A status-only 200 or a historic successful ID is not proof.

## Business connectors and acceptance scope

Inspect the gateway/API contract, state owners, retry behavior and terminal
readers before writing an integration.mjs connector. Expose typed Capabilities
and independent Oracles; use preflight for actual isolation prerequisites and
scoped setup/cleanup with removal readback for prepared resources. Connector
JavaScript is trusted code, not sandboxed. Test environment labels and an opaque
scope string do not by themselves prove tenant isolation.

Keep release negative cases explicit, with expected outcomes supported by
evidence. Use passed or failed as the expected verdict; blocked,
cancelled and inconclusive cannot certify a negative outcome. A listener
or integration continuity gap also prevents a matching verdict from passing.
Prefer passed with an observed rejection assertion or Oracle. Use expected
failed only when all actions and surface assertions complete and a declared
business Oracle fails with preserved independent source facts. An action error,
failed page assertion or runtime signal cannot certify the intended rejection.
A declared suite certifies its saved workflows only. Static route
mapping or all-green declared cases cannot prove whole-project workflow coverage;
that coverage gate is still unimplemented and must remain visible.
`;
