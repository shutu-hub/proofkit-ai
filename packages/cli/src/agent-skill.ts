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

## Reuse or author a scenario

Prefer an eligible, plan-ready catalog Charter or explicit release suite that
matches the requested behavior. Use charterId or suiteId when aliases are
ambiguous. Plan readiness does not prove login, fixtures or running services.

For Web/Electron, use inspect_test_environment to observe configured endpoints
and source association. Resolve its concrete gaps before dependent actions.
MCP does not start the configured application command; use the project's
documented development startup workflow when authorized. Use inspect_surface
when controls or readiness are unknown, then inspect the owning source and
API contract. Configure readyWhen for a real visible prerequisite if needed.
These observations return not-asserted and cannot establish a product pass.

If the catalog has no suitable scenario, submit a structured Charter to
run_test. Read [Charter authoring](references/charter-authoring.md) for this path.
Include a positive surface assertion and, for core/release, a registered
independent business Oracle for the expected terminal result. When no business
reader exists, report the missing contract or implement a workspace connector
within the authorized task; do not invent an Oracle name or infer backend
success from a toast. Observe test identities and isolation before write actions.
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
static routes alone cannot prove that list is complete.

Keep the returned missionId. Call await_test_result for that same Mission. Its
bounded wait returns a terminal summary with current evidence integrity, a
still-running receipt, or a concrete next action if no owner is running. Repeat
the wait for a still-running Mission; read get_mission_evidence after termination
for detailed findings and links. Never restart merely because a wait timed out.
Cancelling the wait does not cancel the Mission.
When run_test or await_test_result reports awaiting-approval with readiness.ready
false, no product test ran. Report testVerdict as not-asserted and explain the
missing planning proof. Do not label it blocked or failed, even if a planning
report was generated. Follow the returned next actions; do not approve an
evidence-deficient Mission.
Cancel with cancel_mission if the user requests a stop. Do not repeat a write
scenario blindly after interruption; inspect saved status and resources first.
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
Check get_mission_evidence.evidenceIntegrity.status before presenting a saved
confirmed finding or repair as currently supported. "degraded" means one or
more presented references or confirmed findings lack verifiable bytes;
"partial" means the bounded result omitted some rows, findings or references;
read acceptanceEvidenceIntegrity for the full Mission reference audit and
claim current support only when every cited finding and repair fact verifies.
"no-evidence" cannot support a product claim. The saved verdict is historical,
and "intact" covers only the presented references, not all project workflows.
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

For an authorized fix, use replay_mission on the original Mission with the
same scope and fixture bytes, then compare_missions after the replay finishes.
Report verified-in-scope only when the comparison says so. A different scenario
or passing page cannot certify the original defect or the entire project.
Mobile inspect_surface returns a bounded driver-label snapshot and evidence with
testVerdict not-asserted; it does not provide validated selector hints or a
device-backed acceptance claim. File selection and response capture currently
support Web/Electron only. Mobile business testing still needs a real-device
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
Multiple matching requests, missing capture or missing reader facts are
inconclusive. Do not reuse an older successful object as proof of this action.

## Business connectors and acceptance scope

Inspect the gateway/API contract, state owners, retry behavior and terminal
readers before writing an integration.mjs connector. Expose typed Capabilities
and independent Oracles; use preflight for actual isolation prerequisites and
scoped setup/cleanup with removal readback for prepared resources. Connector
JavaScript is trusted code, not sandboxed. Test environment labels and an opaque
scope string do not by themselves prove tenant isolation.

Keep release negative cases explicit, with expected outcomes supported by
evidence. A declared suite certifies its saved workflows only. Static route
mapping or all-green declared cases cannot prove whole-project workflow coverage;
that coverage gate is still unimplemented and must remain visible.
`;
