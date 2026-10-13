# Agent Integration

ProofKit is designed to be used by a coding agent. The user describes the behavior in natural language; the agent calls the ProofKit MCP server and receives a compact, evidence-backed result. The tested repository does not need ProofKit test code in its business modules.

## Agent onboarding

After installing the built package, generate a native connection bundle:

```bash
proofkit agent setup --harness codex --root /path/to/source --workspace /path/to/test-workspace --install-skill
proofkit agent setup --harness claude-code --root /path/to/source --workspace /path/to/test-workspace --install-skill
proofkit agent setup --harness deepseek-harness --root /path/to/source --workspace /path/to/test-workspace --install-skill
```

For a one-command Codex or Claude Code setup, add `--register-host` instead of
`--install-skill`. This installs the Skill, checks the generated local MCP
connection, then asks the host CLI to register that server in the user's host
configuration. Registration is an explicit opt-in; plain `agent setup` still
only exports reviewable files. On Windows ProofKit invokes a native host
executable or JavaScript entrypoint without a shell. Use `--host-cli <path>`
when automatic discovery cannot find one. DeepSeek Harness and `generic` hosts
use their own documented configuration workflow.

The returned `hostRegistration` is `registered`, `review-required`, `blocked`,
or `unverified`. An existing server name is `review-required` and is never
overwritten, even if it appears similar. A timed-out or failed add is
`unverified`; inspect the host configuration before retrying. A successful
registration confirms that the host CLI reports the expected stdio command,
arguments and source/workspace environment for its server entry, not that a live
agent discovered the Skill, completed a tool call or tested the product.
Start or refresh the host session, call `inspect_test_scope`, and check the
project binding before running a scenario.

For a registered business Charter, call `inspect_integration_readiness` with
its `charterId` before creating or starting a Mission. The connector must expose
an explicit read-only `readiness` hook; ProofKit does not reuse the Run
`preflight`, because that lifecycle hook is trusted connector code with no
read-only guarantee. Readiness creates no Mission or Run, calls no setup,
capability or Oracle, and returns `testVerdict: not-asserted`. `blocked` lists
prerequisites reported by the connector; `unavailable` means there is no
readiness hook or it could not return a verified result. The CLI equivalent is
`proofkit readiness <charterId> --root <source> --workspace <test-workspace>`.
The optional `check.issues` list carries stable connector codes and short
guidance; never treat a reported prerequisite as proof that an endpoint or
business outcome was actually exercised.

For a reviewed unregistered candidate, call the same tool with `charterPath`
and the exact `charterSha256` returned by `inspect_test_scope`. These replace
`charterId`; do not combine the two selection forms. CLI accepts
`proofkit readiness --candidate <path> --candidate-sha256 <digest> --root <source> --workspace <test-workspace>`.
The shared candidate reader rejects changed file bytes or resolved endpoint
bindings, redirected/oversized files and paths already registered in the catalog.
Candidates must declare their supported surfaces. The result carries that
path/digest identity, level and declared surfaces. A `ready` result does not
clear planning gaps, authorize writes or admit a Mission; retain the requested
level, surface and acceptance scope when creating it, and use normal execution
preflight for current prerequisites.

Choose the command for the host you use. The external bundle lives under
`.proofkit/agents/<harness>/<content-hash>/` and contains a portable
`proofkit-test/SKILL.md`, `references/charter-authoring.md`, native `mcp.toml`
(Codex), `mcp.json` (`mcpServers` for Claude/generic), or `cordis.patch.yml`
(DeepSeek Harness), and `setup.json`.
It uses the installed absolute Node/MCP entrypoint paths and binds both
`PROOFKIT_ROOT` and `PROOFKIT_WORKSPACE_ROOT`. Moving or uninstalling the
package requires a new export and host registration. The server name hashes
the source/workspace pair so different bindings have different names.

`--install-skill` installs to `~/.agents/skills/proofkit-test` for Codex or
`~/.claude/skills/proofkit-test` for Claude Code, or
`${DSH_HOME:-~/.dsh}/skills/proofkit-test` for DeepSeek Harness. `--skills-dir`
overrides the personal discovery directory and requires `--install-skill`. A
generic harness can consume the JSON fragment; its Skill discovery is
host-specific, so an explicit `--skills-dir` is required to install.

DeepSeek Harness uses a Cordis patch list, not the Claude `mcpServers` JSON.
The emitted `connection.activation` is an argument array for a one-shot run:

```bash
dsh headless --patch /path/to/test-workspace/.proofkit/agents/deepseek-harness/<content-hash>/cordis.patch.yml "测试登录核心链路"
```

Use the actual `connection.configPath` from `agent setup`. The patch inserts
one `@deepseek-ai/dsh-mcp-client` stdio entry whose `serverName` is bound to
the source/workspace pair. To enable it persistently, merge that **one insert
row** into the existing `$DSH_HOME/profiles/<profile>/cordis.patch.yml` or
`$DSH_HOME/cordis.patch.yml`; preserve all other rows. `--register-host` is not
available for DeepSeek Harness because its documented activation is a patch
overlay, not an imperative MCP registration command. `--check-connection`
checks the emitted ProofKit server directly; `dsh --dump-config` can confirm
that a particular Harness profile composes the patch. Neither check proves
that the model chose the Skill or performed a product test. This adapter was
designed against upstream revision
[`d743267`](https://github.com/deepseek-ai/deepseek-harness/commit/d743267388641bc76f17c45ce8b4c231aed1d32c)
(developer preview); host behavior should be rechecked when upgrading Harness.

Use `connection.registration.command` and its **argument array** to register
the server with the host, or merge the generated native fragment through the
host's configuration workflow. The Claude registration uses user scope;
Codex uses its native `mcp add`. Plain setup does not execute these commands or edit
host MCP settings. Avoid joining arguments into an unescaped shell string:
paths and environment values can contain spaces or shell characters.
Refresh the host's Skill discovery if required, then call `inspect_test_scope`
through that host and check the source binding. A generated bundle reports
`connection.status: not-checked` and `testVerdict: not-asserted`.

Add `--check-connection` to the same setup command to launch the emitted local
MCP server, list its required high-level tools, and call `inspect_test_scope`
to verify the source/workspace binding. `--check-timeout-ms` bounds the whole
check (default 30000, accepted 1000–60000). The separate `localConnection`
result is `connected` or `blocked`; it always keeps `hostRegistration`,
`modelBehavior` and `executionChecks` at `not-checked`/`not-run`, and the
product verdict at `not-asserted`. This does not confirm that Codex, Claude
Code or another host discovered the Skill or accepted the MCP configuration.
The server loads trusted connector registration code during startup, so run
this optional check only with a reviewed external workspace integration.

The Skill preserves scope/platform/intensity, defaults to `core`, reuses
eligible saved scenarios or submits a validated Charter, requires independent
business evidence, follows one Mission through termination, and reports the
saved verdict with evidence and scoped repair comparison. It cannot configure
an unknown application's login, isolation, APIs or business invariants merely
by being installed. Configure those in the external workspace, then verify a
real workflow. Syntax and MCP connection tests do not establish model behavior.

`inspect_test_scope` also returns bounded `workspaceCandidates` from external
Charter directories when files have not been registered in the catalog. The
agent can use their paths and fixed issue codes to find existing examples,
including a `fallback-unmatched` set for a focus that missed their literal
names. Candidate discovery does not approve, register or execute a scenario.
For a reviewed candidate, give `run_test` its `charterPath` and `charterSha256`
from the latest scope result. The Mission entry point rereads that bounded
external file, rejects a changed digest and applies the normal Charter, level,
policy and evidence gates. The candidate's parsed contents are frozen into the
Mission; a later file edit cannot change an already planned Run.

For the AIHR reference, explicitly choose `proofkit agent setup --harness
codex --template aihr --root <AIHR-source> --workspace
<external-test-workspace> --install-skill` on first setup. This installs the
packaged connector and example Charters before the generic starter can occupy
`integration.mjs`. It neither loads the connector nor registers a scenario or
starts a test. Review the trusted JavaScript and provide isolated test
configuration before rerunning `agent setup` without `--template` for an
optional `--check-connection` or `--register-host`. Both options load the
connector, so combining either with initial template selection is rejected.
`proofkit template install aihr` remains available as a standalone first step.
An existing generic or custom connector is preserved; choose a fresh external
workspace or review and merge the reference deliberately.

Setup validates the existing project/workspace binding, canonicalizes output
paths, rejects source destinations and workspace path escapes, and does not
import trusted connector code unless the optional connection check starts the
generated server. The default is external even when the source
has a legacy `.proofkit`. Identical exports/installations are reused; custom,
modified, incomplete or redirected artifact trees cause a conflict without
overwrite. Bundles are published from complete temporary directories. New
config/Skill content creates a new bundle; changing an existing installed
Skill requires reviewing and moving the old Skill before reinstalling.
The path checks are cooperative local protections, not an adversarial
filesystem sandbox or crash-durability guarantee.

## Evidence-linked repair hypotheses

After `get_mission_evidence` confirms a failed terminal Mission, the host can
inspect the relevant source and call `submit_repair_hypothesis`. Supply the
latest `summary.revision` as `expectedRevision`, a confirmed Finding's ID and
evidence IDs, a title, rationale, proposed `changes`, confidence, and
`regressionCheck`. Each `sourceReferences` item contains a repository-relative
path, the SHA-256 of the exact file bytes, 1-based `startLine`/`endLine` and an
explanation connecting that source range to the observed failure.

The CLI uses the same validation and Mission store:

```bash
proofkit mission propose-repair <mission-id> --input hypothesis.json --root <source> --workspace <test-workspace>
```

Submission checks the current revision, Finding ownership, evidence integrity,
source containment, digest and line range under exclusive Mission ownership.
It saves only advisory metadata; `status` stays `proposed` and the submission
returns `testVerdict: not-asserted`. References describe the **current checkout**,
not attested historical served bytes, and a matching digest does not prove cause.
Refresh evidence to get `repairSourceAudits` and a compact report showing the
proposed change, regression check, failure evidence and stale references.

After an authorized source repair, use `replay_mission` and read its audited
result. `verified-in-scope` proves only that the original defect was not
reproduced in the same configured scope. It never marks the hypothesis itself
verified. A core Mission that stops on its first failure may lack a final Git
snapshot: source freshness remains `unverified`, while its intact historical
failure facts remain readable. Changed proposal references alone do not certify
or withdraw a product outcome.

## Host effectiveness check

The source checkout includes two distinct evaluations after `pnpm build`:

```bash
node tests/host-evaluation-baseline.mjs
node tests/host-evaluation.mjs --run --cases core-pass,core-defect,core-pending,project-gap,quick-pass,author-core
# No catalog or registered business Oracle; the host must author an inline reader:
node tests/host-evaluation.mjs --run --implicit-skill --cases inline-core-pass,inline-core-defect
# Unregistered external Charter: discover, review, then run with its path and SHA-256:
node tests/host-evaluation-baseline.mjs --cases candidate-core
node tests/host-evaluation.mjs --run --implicit-skill --cases candidate-core
# Set PROOFKIT_ELECTRON_PATH before cases containing Electron.
# Seed a wrong job relation behind a successful UI submission, on Web and Electron:
node tests/host-evaluation-baseline.mjs --cases candidate-core-defect,candidate-electron-defect
node tests/host-evaluation.mjs --run --implicit-skill --cases candidate-core-defect,candidate-electron-defect
node tests/host-evaluation.mjs --run --implicit-skill --cases inline-electron-pass,inline-electron-defect
# Claude Code uses its own Skill and MCP config with the same fixture and verifier:
node tests/host-evaluation-baseline.mjs --protocol claude-code --cases quick-pass,core-pass,core-defect
node tests/host-evaluation-baseline.mjs --protocol claude-code --cases mobile-quick-pass,mobile-core-pass,mobile-core-defect
node tests/host-evaluation.mjs --run --implicit-skill --cases mobile-core-pass,mobile-core-defect
node tests/host-evaluation.mjs --run --host claude-code --implicit-skill --cases quick-pass
```

The Claude evaluator runs `claude -p` with the generated `.claude/skills`
directory, `--strict-mcp-config`, an explicit tool allowlist and a structured
answer schema. It pairs Claude stream tool calls with completed tool results
before applying the same saved Mission, Run and evidence verifier. A local
2026-10-12 attempt loaded the generated `proofkit-test` Skill and listed the
ProofKit MCP tools in Claude's initialization event, then stopped on a provider
401 before any MCP call. It was classified `infrastructure-blocked`; discovery
is verified, but Claude model behavior and product acceptance are not. Set
`PROOFKIT_CLAUDE_CLI` to a native executable or JavaScript entrypoint when the
CLI is not on the evaluator's default path.
The scripted protocol command executes the actual ProofKit stdio MCP calls in
the synthetic browser fixture, serializes their responses as Claude-shaped
`tool_use`/`tool_result` events, parses the final `result`, and applies that
same Mission/Run evidence verifier. It writes the transcript beside
`baseline.json` and reports `modelAdherence: not-evaluated`; it checks protocol
handling and evidence consistency, not a Claude model run.
The optional mobile cases use the same external workspace and native MCP
launcher with a local fake W3C WebDriver. `quick` checks the requested surface
and visible text. The two `core` cases click a native control, observe a fresh
submission ID on the UI, then query an independent read-only business endpoint
for that ID. The seeded wrong-job relation fails despite a success label. The
verifier checks the saved mobile adapter, current-action ID, Run-linked Oracle
source and SHA-256 evidence. Real Codex implicit-Skill runs passed both core
cases in this fixture; a device and real mobile business remain separate gates.

Set `PROOFKIT_ELECTRON_PATH` to a local Electron executable and run
`node tests/host-evaluation-baseline.mjs --cases electron-core-pass,electron-core-defect`
for the optional desktop cases. The first command uses the generated native MCP launcher and real Chrome, but scripted
tool calls. It verifies saved Missions, Runs, report links and SHA-256 evidence
for success, a wrong business relation, an unfinished worker, a whole-project
coverage gap, a quick page check and a submitted Charter without a catalog
entry. Its `scripted-mcp-baseline` result **does not measure an AI host**.
The desktop cases use a separate Electron profile and CDP port, and the
verifier rejects an answer or saved Run silently switched to Web.
The optional inline Web and Electron cases expose a local read-only status endpoint but no
catalog Charter or registered Oracle. The host must capture the current POST
file ID, author `httpOracles` in its Charter, and cite the independent source
artifact. The defect case returns an older successful file ID from the reader;
the verifier requires a failed business result rather than accepting its
`complete` state. Run the same case IDs through
`host-evaluation-baseline.mjs --cases inline-core-pass,inline-core-defect`
or `--cases inline-electron-pass,inline-electron-defect`
when checking the scripted transport without a model.
The optional `candidate-core` case leaves a complete core Charter in the
external workspace without registering it. The scripted baseline takes its
path and SHA-256 from `inspect_test_scope.workspaceCandidates`; the real host
must independently review the source and use that same digest-pinned path.
The verifier rejects an inline replacement, a stale digest, a changed Charter,
or a Mission that does not retain the selected candidate's path and digest.
Both evaluations run against an isolated synthetic product, so this case
measures host behavior rather than AIHR acceptance.
The scripted baseline and three real Codex implicit-Skill runs passed (1/1 in
each run). The host recovered from an absolute-path error in one run and an
extra `sideEffectPolicy` argument in the next. After the Skill and MCP tool
descriptions stated both constraints, a third run used one successful
`run_test` call with the candidate path and digest. This is one synthetic
scenario, not a measured cross-project success rate.
The optional `candidate-core-defect` and `candidate-electron-defect` cases
seed a wrong job relation while the page reports a successful submission.
The scripted baseline and an initial real Codex host run passed 2/2; each
real case used one successful path-based `run_test` call. A stricter verifier
then required the confirmed product Finding to reference the current Run's
digest-checked business source. The Web re-run passed within 240 seconds; the
Electron host completed its Mission but timed out before its final answer at
240 seconds, then passed a separate 360-second run in 88 seconds. Host latency
is variable, so the timed-out attempt remains an incomplete evaluation.
In the scripted baseline, `core-pass` omits `surface` to check the ordinary Web fallback. The optional `electron-core-pass` also omits it, checking desktop intent selection through the full MCP and Electron path when an Electron executable is provided.
The `run_test` start receipt returns the selected `surface` and full `executionProfile.surfaceMatrix`, so the host can inspect the saved execution target even when it omitted the input platform.

The second starts the installed Codex CLI with its existing provider and
credentials. It activates `$proofkit-test`, records the host's actual MCP calls
and structured answer, then checks both against saved Mission/Run state. Add
`--implicit-skill` to measure ordinary natural-language activation separately.
On Windows, `--windows-sandbox unelevated` applies only to this evaluator's
Codex invocation when the configured sandbox cannot start commands; it does
not edit Codex settings. Use it only with the isolated synthetic fixture.
The evaluator explicitly permits calls to its own synthetic ProofKit MCP
server so unattended runs can submit to its in-memory loopback fixture and save
evidence; connector write capabilities remain disabled. [OpenAI's CLI reference](https://developers.openai.com/codex/cli/reference/)
documents the workspace flags, and [Windows sandbox guidance](https://developers.openai.com/codex/windows/windows-sandbox/)
describes the isolation tradeoff of the unelevated fallback.
The report records elapsed times for the first and last completed MCP call,
the last completed agent message, and `turn.completed`. If the host times out
after writing a schema-shaped agent message, the evaluator separately checks
that message against saved evidence as `provisional`. The case remains
`incomplete`, its official validation stays failed, and it never increments
the passing count. In one implicit Skill `candidate-core-defect` run, the
360-second host deadline expired after a failed product Mission and a candidate
answer; no official answer file or `turn.completed` event was saved. That run
is an incomplete host evaluation, not a passing acceptance result.
It uses only synthetic loopback facts; it does not contact AIHR or authorize
business writes. Model usage may incur provider charges. A provider access
failure or cancelled host MCP call is reported as `infrastructure-blocked`,
and remaining cases are left unrun. Neither is scored as a model or product
failure. Reports and event traces are retained under the printed temporary
evaluation root. All eight synthetic cases passed the stricter scripted MCP
baseline, which binds the submitted object's captured ID to independently read
Oracle facts. All eight cases passed separately through a real Codex host with
implicit Skill activation under this gate: six Web cases, including an
unexecuted whole-project request correctly labeled `not-asserted`, and two
Electron core cases. The earlier eight real-host passes used a fixed historical
object and do not prove current-action identity.
Broader adherence and false-pass rates remain unmeasured.
With Windows `unelevated` sandbox in the isolated fixture, all four optional
inline Web/Electron cases also passed the real Codex implicit-Skill evaluation:
the normal current-ID reads passed, and the historical-ID reads produced
evidenced business failures on both surfaces. The default Windows sandbox stalled before a ProofKit call
while reading the Skill; that incomplete attempt is a host execution limit,
not a product verdict. These fixtures do not establish live AIHR or
general cross-project effectiveness.

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

Read `inspect_test_scope.planningReadiness` before choosing a Charter. Its bounded gaps distinguish level and surface mismatch, invalid or omitted plans, unresolved candidate endpoint bindings, and literal source or Oracle-name misses. For `inspection-incomplete`, use the gap code: refine focus or limit (at most 50) when details were omitted; for `candidate-endpoint-binding-unavailable`, inspect the focused external Charter, configure its named environment URL to a reviewed test endpoint, then repeat scope inspection before authoring a replacement. An unresolved binding leaves candidate enumeration complete when the file was found; it does not make the Charter executable. When a required surface connection is missing, `next` omits `inspect_surface` and `run_test`; `inspect_test_environment` explains the connection gap. `authoring-needed` calls for a compatible scenario. `candidate-review-needed` means a visible, same-level external Charter has no reported structural issue. Inspect that file and the source flow, then pass its relative path and SHA-256 from the same scope result to `run_test`, or register it. This status does not validate the live target, business data or test result; a matching quick Charter never substitutes for requested core proof.

Register one local MCP server for the project root. Clients with MCP support, including Codex and Claude Code, use the same high-level tools. DeepSeek Harness can use this interface when its harness supports MCP, or invoke the CLI otherwise:

```text
discover_project
inspect_test_scope
inspect_integration_readiness
inspect_test_environment
inspect_surface
  interact_surface
list_test_charters
list_test_suites
run_test
await_test_result
get_mission_status
get_mission_evidence
cancel_mission
replay_mission
compare_missions
analyze_mission_stability
create_mission_repeat
get_mission_repeat_status
advance_mission_repeat
```

`run_test` is the shortest path for an agent:

```json
{
  "intent": "测试简历获取，确认文件生成、候选人识别和终态可用",
  "level": "core",
  "surface": "electron"
}
```

The response contains `missionId`, the resolved level and the running status. The agent uses `await_test_result` with that ID until it receives an audited terminal brief. That response includes cited evidence and can support the final answer directly. Read `get_mission_evidence({ missionId, detail: "full" })` only when the needed link or per-Run detail is omitted. For a review-first workflow, call `create_test_mission`, inspect the task graph, call `approve_test_plan`, and then call `start_mission`.

For an unfamiliar project, first call `inspect_test_scope({ surface: "electron", level: "core" })`. It joins source-backed candidate entry points/routes, compatible saved Charter/Suite checks, registered business Oracles and capability input hints in one bounded response. `focus` optionally filters by a literal source-path, alias or registration substring; it does not understand a whole natural-language request. `limit` defaults to 20 and is capped at 50 details per section. Use total/matched/omitted counts and `inventory.truncated` to describe the actual inspected scope. Gin group prefixes are composed conservatively within each file; `inventory.routeDiagnostics` gives unresolved declaration locations and total/omitted counts, never guessed paths. Route `declared` status only means a catalog mapping exists; it can coexist with `planReady: false` and never proves execution.

`planReady` validates saved plan structure and registered operation names using the normal catalog validators. It does not check credentials, endpoints, fixture readiness or business truth. The tool returns `not-asserted` and `not-run`, creates no Mission/Run and invokes no connector operation or surface connection. Loading the service still loads trusted connector registration code. Capability `inputShape` omits default values and user callbacks, marks incomplete descriptions as partial, and leaves runtime Zod validation authoritative. Follow with live `inspect_surface`, then reuse a ready catalog ID or submit a complete Charter to `run_test`; register a trustworthy business Oracle when the requested level requires one.

For a large repository, use a module path or name, for example `inspect_test_scope({ focus: "resume-collection", level: "core", surface: "web", limit: 50 })`. Focus now prioritizes retention before route/entry caps, rather than filtering only the first global candidates. A matching eligible Charter alias also prioritizes its declared routes; `inventory.retentionFocus` records the normalized query. Totals describe retained candidates, with duplicate declarations in one source collapsed; `omitted` describes response details omitted from that slice. File discovery and reads remain bounded, so `truncated` must still be reported. Route-text focus cannot recover unscanned files, and filesystem discovery only prioritizes paths it has discovered.

Before connecting to a configured Web/Electron page, call `inspect_test_environment({ surface: "electron" })` (CLI: `proofkit environment --root /path/to/source --surface electron`). It observes configuration, the surface HTTP status where applicable, CDP discovery HTTP status, up to eight declared backend health endpoints and local listener/source association. A reachable loopback health endpoint is associated with its own listener: an evidenced different checkout is blocked by default even when the selected page belongs to the expected source. Shared origins are inspected once per observation. A Run checks already-running declared local health listeners before setup; after project or connector setup it checks again before browser attachment. A known foreign listener blocks with a sanitized `preflight.json` or `post-setup-check.json` artifact. The AIHR reference connector additionally checks its actual gateway URL before and after setup, even without a declared health endpoint, and compares its configuration and listener again at Run completion. A changed or unavailable previously verified gateway makes the Run inconclusive; other undeclared connector endpoints and changes between observations remain outside this check. Unavailable ownership remains unverified. For an Electron `file:` page, source association uses the CDP listener after resolving its port file; this is a process-path check, not a renderer-byte attestation. All checks share one 100–15000 ms deadline, defaulting to 10000 ms so a cold Windows listener/process lookup can finish. It returns `checks-passed`, `blocked` or `incomplete`, a `notChecked` list, and a JSON artifact path with SHA-256 in the external workspace. The CLI exit codes are 0, 1 and 2 respectively.

The `next` array gives bounded host guidance as `{ action, basedOn, guidance }`. Each action cites check IDs from the same observation: configure the external workspace, verify the documented local startup and endpoints, correct CDP or health checks, confirm source association, or retry an expired inspection. `inspect-surface` appears only when no check is blocked, the deadline did not expire and no different checkout was identified. Guidance contains no generated shell command, endpoint query, credential or raw network error. Resolve blocking checks and repeat inspection before treating the environment as ready; even `checks-passed` still requires a live surface inspection and actual business assertions.

Environment observations always carry `testVerdict: not-asserted`. They do not start an app/browser, create a Mission/Run, or invoke connector preflight, setup, capability or Oracle operations. Service creation still loads trusted connector registration code. Probes issue GET requests, follow no redirect, and retain no response headers, query, fragment or raw network error. Ordinary HTTP probes stop at headers without retaining a body; the mobile status probe reads at most 8192 bytes and retains only the ready boolean. Endpoint paths remain visible. MCP health/CDP probes require loopback; a configured Web surface follows the ordinary configured-origin policy. WebSocket CDP endpoints need live surface inspection and remain unverified here. Missing source association or backend health configuration stays explicit. A 200 response does not prove a CDP session, selected page, login, fixture availability, isolated test scope or business terminal state. Use `notChecked` to continue with the required checks; never convert this result into a product pass. Cancellation propagates the caller's reason; an expired observation deadline returns incomplete checks as unverified.

For mobile, call `inspect_test_environment({ surface: "mobile" })` before attachment. It reads only the configured WebDriver `/status` response (at most 8192 bytes) and requires a W3C `value.ready: true` to pass the driver check. It creates no device session. MCP requires a loopback driver; its process is test infrastructure, not proof that the mobile app comes from the selected checkout. `notChecked` includes `device-session`, and a ready driver is never a product verdict.

For a `core` or `release` Run whose pre-action listener check identified one PID, ProofKit checks that listener again before closing the surface, including when an assertion or Oracle throws. The Run saves a returned second observation and reports `targetContinuity`; a changed or unverified listener makes an otherwise passed or failed Run inconclusive. Cancellation and pre-connection blocks retain their verdicts. A probe error records unverified continuity without a second observation. This is a point-in-time process check, not an attestation of page bytes. `quick` avoids the extra check.

Before drafting a new Charter, call `inspect_surface({ surface: "web" })` or `inspect_surface({ surface: "electron" })` against an already running local page. It records a read-only observation Run and returns bounded controls, including hidden file inputs with `inputType: "file"` and `visible: false`, and a selector only when it matched exactly one element at inspection time. The result says `testVerdict: "not-asserted"`; it is reconnaissance, not a pass. Control hints cover the main frame only, are capped at 60, omit input values, and can become stale after navigation. Web/Electron `click`, `fill`, `press` and `setInputFiles` recheck selector uniqueness during the test Run and fail on ambiguity. The Run keeps snapshot, screenshot and event evidence in the external workspace. Use isolated test data because screenshots can contain everything visible on the page.

The overview returns at most 2,000 text characters. To read a longer rendered region, use the same tool:

```json
{"surface":"web","readText":{"selector":"#results","offset":0,"limit":4000}}
```

Use the returned `snapshot.textRead.nextOffset` and `sourceSha256` for the next request's `offset` and `expectedSourceSha256`. Continue until `nextOffset` is `null`; the optional EOF read returns zero characters. Counts and offsets refer to **sanitized rendered text**, in JavaScript UTF-16 code units. Each response and its saved Run retain the full requested window, up to 8,000 units. The entire bounded region is sanitized before slicing, so sensitive text crossing a window boundary is redacted together.

Continuation is pinned to the live page URL, selector and entire sanitized region. If any binding changes, the read becomes inconclusive with `surface-text-read-changed`; restart at zero and discard mixed-state windows. It proves consistency of that rendered region at each read, not server freshness or business correctness. A region over 200,000 units, an out-of-range offset, an ambiguous/hidden/missing target or unsupported adapter cannot silently fall back to the overview. Select a narrower region or resolve the recorded gap. This API supports Web/Electron rendered main-frame HTML only; iframe, hidden, virtualized, paginated and other-page records require their own supported navigation/observation. A complete region read still has `testVerdict: "not-asserted"`; final acceptance requires explicit assertions and an independent Oracle.

When a workflow needs several page steps, call `interact_surface({ surface: "web", action: { kind: "click", selector: "#next" } })` for one step at a time. It accepts `goto`, `click`, `fill`, `press`, `selectOption`, `selectOptions`, `setChecked`, and `waitForText`; the action and a fresh observation share the owned browser context. Separate Runs that launch Web create their own context; put dependent steps in one Charter. Persistent calls require a trusted task owner supplying a context, as the benchmark controller does, or attachment to the same existing CDP page. The response shows the action status, a bounded scrubbed snapshot, and saved evidence, but always says `testVerdict: "not-asserted"`. Form interactions require `policies.sideEffects: allow` in the isolated workspace. An Electron `goto` is rejected, and a Web URL must use loopback or the configured origin. Use `run_test` for the final assertion and required business Oracle; an exploratory sequence by itself is not an acceptance test. Keep `await_test_result.timeoutMs` within 500–30000 ms and repeat the wait for a longer Mission.

Native Web/Electron form actions are shared by MCP exploration and deterministic Charters:

```json
{"kind":"selectOption","selector":"#status","option":{"label":"Complete"}}
{"kind":"selectOptions","selector":"#statuses","options":[{"value":"complete"},{"label":"Pending"}]}
{"kind":"selectOptions","selector":"#statuses","options":[]}
{"kind":"setChecked","selector":"#enabled","checked":true}
```

`selectOption` targets one native single-select, with exactly one matching `label` or `value` (including an empty placeholder value). `selectOptions` replaces the entire native multiple-select set, with at most 32 exact descriptors; an explicit empty array clears selection. Request order does not matter. Every descriptor must match exactly one distinct enabled option before any selection is dispatched; duplicated labels/values, two descriptors resolving to the same option, and disabled options/optgroups are rejected. Readback verifies the complete requested set, including absence of extra selected options. `setChecked` targets a native checkbox or radio; clearing a radio requires selecting another radio. No index, forced action, ambiguous option or custom ARIA widget fallback is accepted. The adapter reads the resulting state and saves bounded `receipt.metadata.nativeForm` facts without copying option labels/values into the receipt. Disabled, ambiguous, unsupported or unverified state produces an inconclusive Run with a stable diagnostic code; it is not a confirmed product defect. A selector matching multiple controls still follows the existing ambiguity error. All native form actions require `sideEffectPolicy: allow`; the mobile adapter explicitly blocks them. Readback establishes immediate control state, not persisted business success.

Inspected native controls also carry `nativeForm`: select multiplicity and option/selection counts, or checkbox/radio checked state. `nativeActions` suggests the applicable action only when a unique selector, visibility and enabled state were observed; otherwise it is empty. Native multiple-selects and single-selects with `size > 1` use the `listbox` role. Hints contain no option contents, can become stale, and do not authorize writes or guarantee actionability. The adapter checks the live control again when acting.

To retain real Chrome/Electron verification artifacts, set `PROOFKIT_INSPECTION_RUNS` to an existing external directory and `PROOFKIT_ELECTRON_PATH` to an installed executable, then run `pnpm test:smoke:inspect`. The output includes the artifact directory. Without the artifact setting the fixture workspace is temporary.

Runs sharing one external test workspace execute exclusively, including read-only inspection and Runs from separate Missions or surfaces. Shared CDP and WebDriver server endpoints are also serialized across workspaces on the same host. Electron port-file attachments lock the file path and, when already present, its CDP endpoint before setup; after setup they lock the final endpoint and pin the adapter to it. If another Run owns the workspace or attachment target, the contender records a `blocked` Run before attaching to the page; report this as test-environment contention and retry only after the active Run and its cleanup finish. Separate workspaces sharing a business account or backend still need explicit data isolation.

For a page that renders asynchronously, configure `surfaces.web.readyWhen` or
`surfaces.electron.readyWhen` once, or override it in
`inspect_surface({ surface: "web", readyWhen: { text: "Log in", timeoutMs: 5000 } })`.
Choose text that must already be visible before the action under test. A
submission success message is an outcome to assert after submission, not an
inspection prerequisite before it. Inspect again when navigation or another
state change makes the first observation stale, or when it lacked the needed
controls; repeated inspection of the same state adds no product proof.
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
surfaces: [web]
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

For a delayed request, add `requestStartTimeoutMs` to the capture and set
`timeoutMs` to cover the trigger, request wait and response. If a reviewed
confirmation button may appear after the first click, add one bounded
`followUp: { kind: clickIfVisible, selector: '...', waitMs: 3000 }` inside
`captureResponse`. It records `clicked` or `skipped` in the response evidence;
multiple visible matches or a missing request remain inconclusive. The
follow-up is an interactive write action and uses the same side-effect policy.

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

For a new workflow, the agent may put the same limited GET reader directly in
the submitted Charter instead of registering it in the external config first.
This example continues the `captureResponse` Charter above; `step-003` refers
to that Charter's third action:

```yaml
oracles: [current-resume-terminal]
httpOracles:
  - name: current-resume-terminal
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
    intervalMs: 500
    deadlineMs: 30000
```

ProofKit validates the name, endpoint, bounds and capture-step references
before saving the Mission. Every scenario that uses this Oracle must bind at
least one `id` field captured in that scenario. The reader sends bounded GET
requests, checks that the independent JSON identifies the current object, and
then evaluates its declared terminal state. In MCP mode its URL must be on
loopback. It cannot carry credentials, arbitrary headers or code, and it does
not create the application's status API. Keep authentication, multiple
readers and richer file/candidate/job invariants in a trusted external
workspace connector. An ID mismatch is a failed business check; an absent
response or terminal state is inconclusive. A one-time HTTP 200 without these
predicates is not a business pass.

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

For repair verification, review the failed Mission's scope and side effects after the application change, then call `replay_mission({ missionId, approve: true })` when the user has authorized another execution. Without `approve: true`, a saved approval requirement or an interactive scenario leaves the new Mission `awaiting-approval`; the host can review it, call `approve_test_plan`, then `start_mission`. CLI uses `mission replay <id> --approve` for a one-command authorized replay. The new Mission stores `replayOfMissionId`; once it finishes, `get_mission_evidence` includes a comparison with the source Mission. `compare_missions` reads the same comparison directly. It requires a direct replay, the same project/workspace and saved Charter or suite scope, every confirmed baseline product Finding linked to intact business facts from a failing Oracle, and a complete passing candidate with all declared Oracle source artifacts intact. Primary, required replay, and declared negative Runs are paired by Charter, surface and run kind. A missing Run, changed scope, unmaterialized artifact or unfinished candidate is `inconclusive`; a repeated evidenced Oracle failure is `defect-reproduced`. Each read rechecks the candidate's final Git fingerprint against the current checkout. A changed or now unavailable candidate source withdraws a saved repair or reproduced-defect claim to `inconclusive`; `historicalStatus` preserves that earlier comparison and `candidateSourceFreshness` explains the current source check. CLI `mission compare` exits 0/1/2 for verified/reproduced/inconclusive. CLI `mission replay` also exits 2 when a failed baseline's passing candidate cannot establish repair, so hosts must read the comparison instead of treating the candidate pass as proof of repair. `verified-in-scope` does not identify which source change fixed the symptom.

To investigate repeatability, execute three to five Missions as a direct replay chain with a fresh approval for each interactive replay, then pass their IDs in order to `analyze_mission_stability` or `mission stability`. The analysis refreshes saved report snapshots in the external workspace but starts no Run. It requires matching source, target origin, scenario scope, file bytes and independent business proof. `variable-outcome` means the observed outcomes changed under those checked boundaries; it does not identify a flaky test, application cause or safe automatic retry policy. An incomplete boundary returns `inconclusive` with specific gaps.

For a process-resumable series, call `create_mission_repeat` on one terminal Mission with current business and Git proof, specifying 3–5 total samples. Call `advance_mission_repeat` to create or resume the next deterministic replay slot, then `await_test_result` for its Mission and advance again. `get_mission_repeat_status` reconstructs progress from persisted Mission slots after a host restart. An interactive replay pauses for a fresh `approve: true` on that slot; the approval does not carry to later slots. CLI `mission repeat run` can drive approval-free slots in one process, while `--approve` authorizes only the next interactive slot. A source change or degraded evidence stops advancement as `inconclusive`; completion includes `MissionStabilityAnalysis` and does not imply a flaky-test cause.

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

`source` may be omitted when the scanned route path is unique. An API target also needs its HTTP method and the exact gateway origin, so a same-path request to another service cannot count. `get_mission_evidence.suiteScope.routeCoverage` reports candidate, mapped and observed route counts, bounded gap details with omitted counts, stale or ambiguous declarations, and whether the project inventory was truncated. A route is **observed** only when its mapped Charter passes with independent business evidence on each surface declared for that Charter, and each required primary Run visits the Web path or receives a matching 2xx API response; `release` also requires the matching replay. The response is linked to that Run's network event log; no runtime URL is copied into the Mission coverage observation. The saved Mission keeps the mapping used for the run, even if the catalog later changes. Coverage gaps are informational and do not change a suite's workflow verdict. These counts describe static candidate routes, not whole-project coverage; calls made only by a backend worker are not browser network observations.

The final evidence gate is checked per primary run and required replay, not across pooled runs. An Oracle must return at least one sanitized observation fact; ProofKit's own Oracle result file does not count as that fact. A negative case cannot make an unverified main path green. Prefer negative cases that pass after positively asserting the rejection. If a case expects a failed Run, all declared actions and surface assertions must complete successfully, and a declared failing business Oracle must have its own preserved source fact. A click error, missing response, failed page assertion or runtime signal does not certify the expected business outcome; saved Mission evidence rechecks the same Run facts.

If a one-sentence request has no suitable Charter and the planner cannot supply an assertion or required Oracle, `run_test` returns `readiness.ready=false` and does not start the surface. Its next-tool hints point to `inspect_test_scope`, `inspect_surface`, `plan_test` and `run_test`. The agent can inspect the gaps and call `run_test` again with a complete structured Charter. Readiness checks structural prerequisites; they do not prove the assertion is meaningful.

After `run_test` starts, `await_test_result({ missionId })` observes the same Mission for up to 20 seconds by default (maximum 30 seconds). A terminal response includes the saved `verdict`, audited `testVerdict`, brief findings, prioritized cited evidence, omission counts, current evidence integrity and report path. It omits full per-Run detail. `still-running` means the agent should call it again with the same ID. `needs-action` means no execution owner is active and identifies the next tool. For an unready Mission, `run_test`, `get_mission_status`, `await_test_result` and `get_mission_evidence` expose `testVerdict: not-asserted`; the wait also repeats the readiness gaps and does not suggest approval. A generated planning report is not a product test result. A wait deadline or MCP cancellation never starts, replays or cancels the Mission. Use `get_mission_evidence({ missionId, detail: "full" })` if the brief omits a link or fact needed for the answer.

Start and nonterminal wait receipts include bounded `progress`: task counts,
the current task ID and, after execution begins, the persisted deadline and
remaining execution milliseconds. These are scheduling facts, not acceptance
evidence. A zero remaining time with an active owner can mean cancellation or
cleanup is settling; continue waiting on the same Mission ID until the owner
returns a terminal state.

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

The terminal wait and `get_mission_evidence` with its default `detail: "brief"` return the same audited projection: verdict and proof status, key findings, at most 12 prioritized evidence links, omission counts, and the path to a compact HTML `report`. Use `detail: "full"` when an omitted link, per-Run fact, all diagnoses, or the complete `MissionResult` summary is needed. The brief projection does not alter the saved Mission, report or audited verdict. Give the user the report entry point alongside the verdict, tested scope and first actionable issue. The report shows the saved Mission verdict, per-scenario/platform results, missing runs, business proof, findings and replay comparison. A negative case retains its raw failed/blocked result and separately states whether it matched the declared expectation. Task counts are progress, not coverage. The adjacent `summary.json` exposes the complete presentation contract without tool inputs/outputs or raw business payloads.

An earlier scripted `candidate-core-defect` Chrome fixture measured 6,166 bytes for the summary-only terminal wait and 17,428 bytes for a separate brief evidence read, versus 47,590 bytes for `detail: "full"`. The current terminal wait now carries that brief evidence directly. These are synthetic case payloads; they do not establish a model latency improvement or live AIHR acceptance.

A real Codex implicit-Skill `quick-pass` case with the terminal brief completed in about 65 seconds with an audited pass and an official structured answer. Its tool trace called `await_test_result` once for the final evidence and did not call `get_mission_evidence`. This checks the intended host path; it does not measure a before/after speedup or validate AIHR.

For several failed scenarios, read the full `diagnoses` list and the per-diagnosis `diagnosticSupport.diagnoses` results. The singular `diagnosis` is only the Mission headline, chosen from the first confirmed product Finding. The compact summary shows at most ten diagnoses and reports `omittedDiagnoses`; use the full saved Mission before claiming every diagnosis was reviewed. Each visible diagnosis keeps its own Finding and Run evidence link, so a later UI mismatch cannot overwrite an earlier product diagnosis or borrow its evidence.

Read the terminal result's `evidenceIntegrity` before repeating a saved product finding or repair claim. It separately reports the current integrity of the bounded, presented references (`intact`, `degraded`, `partial`, or `no-evidence`), counts changed or unavailable files and legacy references without digests, and names visible saved-confirmed findings whose cited evidence is no longer complete. Repair comparison checks cited Run rows and defect facts against their declared baseline or candidate Run; omitted comparison rows or defects make the presentation `partial`. The same projection is in `summary.evidenceIntegrity` and `summary.json`. The saved acceptance verdict remains historical; an `intact` projection does not prove omitted findings, the entire source project, or the application state at another time. A report write failure still returns this integrity projection through MCP.

Also read `proofClassification`, `acceptanceEvidenceIntegrity` and `sourceStability` on the same result. New Runs explicitly record whether each Oracle verified business state or only an HTTP status contract. A saved Run from before that protocol may lack the kind; `unverified` lists the bounded count and Run IDs. Unreadable or excess Runs also keep this audit unverified. `explicit` confirms only that the kinds were recorded; it does not replace the Mission's business, coverage or evidence gates. The full Mission acceptance audit checks up to 2048 saved execution and Finding references within a 15-second batch deadline independently of the compact report. Diagnosis and repair proposals have separate support checks in the compact report. A compact `evidenceIntegrity: partial` may coexist with `acceptanceEvidenceIntegrity: intact`; omitted display links alone do not invalidate an ordinary passing Run. A saved `core` or `release` pass without explicit Oracle classification, any saved pass with degraded, absent or audit-limited Mission acceptance evidence, or a saved pass/failure whose complete Git source fingerprint changed during execution, returns `testVerdict: inconclusive` and a `testVerdictReason`; `verdict` remains the historical value. Missing Git fingerprints are `unverified` and do not by themselves downgrade a declared-scenario test. The same audited claim is saved in `summary.json` and displayed in the static report. The unaudited `get_mission_status` receipt keeps `testVerdict: not-asserted` even if its nested historical Mission has `verdict: passed`. Rerun the affected scenario to obtain current business proof.

A saved `failed` result also needs current evidence before it can support a product-defect claim. A saved confirmed product finding with unclassified Oracle proof, changed or missing cited evidence, or an observed Run that no longer matches its frozen Charter and recorded facts yields `testVerdict: inconclusive`; the historical `verdict: failed` and finding remain visible for audit. Its execution audit uses `scope: observed-failure` and counts later unexecuted slots separately. An ordinary test failure with intact evidence and no confirmed product finding remains `failed`. Recheck source and rerun before telling the user that an unsupported saved finding is a current product bug.
The proof audit separately counts passing and failing business Oracles and HTTP-contract checks. A recorded Oracle kind alone cannot satisfy the core/release pass or confirmed-defect gate: every required primary/replay Run needs a passing business Oracle with a source artifact in that Run's evidence, and each confirmed product Finding must cite a source artifact from a failing business Oracle in its own Run. Cross-Run or unrelated same-Run evidence cannot certify a defect. Current evidence integrity still needs review.

Reports are static snapshots with revision and generation time. A new evidence request regenerates them; they do not refresh themselves. Missing files, rejected paths and recorded-digest mismatches appear as unavailable evidence rather than working links. When generation fails, `reportUnavailable` explains the limitation and the saved verdict/evidence remain readable. Report rendering never decides acceptance. Project-wide acceptance requires a trusted signed workflow review, a complete candidate audit without exclusions, the exact declared Charter and surface matrix, and current execution evidence. Even then, the claim is limited to reviewed source workflows; semantic completeness depends on the review.

`get_mission_evidence.targetBindings` lists the source-to-target process association for each Web/Electron Run. On Windows and Linux with usable `/proc` socket metadata, a loopback listener whose code path points to a different Git checkout blocks the Run by default; an unknown association is reported as `unverified`. A matching process path does not prove the server delivered the current source bytes, so the agent should not describe it as full source attestation. A privileged Ubuntu CI smoke has validated the Linux listener path; an unprivileged hosted run could not read every process file descriptor and remained `unverified`. The test workspace may set `policies.targetBinding: record` for an intentional cross-checkout diagnostic.
Repair comparison is `inconclusive` when one side has no target association record, the target origin changes, or either recorded listener belongs to a different checkout. Historical Runs with no association record on either side retain their existing comparison behavior; a repeated `unverified` association still cannot prove served-byte identity.

The protocol deliberately separates the audit layers: `AgentStep` explains why a task was selected, `ToolCall` records the registered operation, `Observation` records typed facts, and `Evidence` points to artifacts that can be reviewed. `summary.agentTraceAudit` rechecks their saved ownership and attempt chain when evidence is opened. A missing legacy chain is `unverified`; a contradictory chain is `incomplete`. Both withdraw the current `testVerdict` for a saved pass or failure while preserving its historical `verdict`. The evidence response is bounded; large tool inputs and outputs remain in the local Mission file rather than being copied into every MCP response.

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
Mission creation rejects a supplied `level`, inline Charter, catalog Charter or suite that conflicts with an unambiguous intensity in the user's wording. If the wording contains multiple intensity cues, the host should interpret them in context; ProofKit does not treat one keyword as a definitive conflict. A neutral request such as “测试登录功能” may use an explicitly selected Charter at its registered level.

## Choosing acceptance scope

`level` describes test intensity; `coverage` describes what the verdict accepts. The default `declared` scope accepts only the saved Charter or suite scenarios. A successful release suite remains acceptance of those scenarios, even if the source scan contains more routes. A partial inventory is retained in `planning.coverage` and does not by itself stop a complete declared module test.

For a whole-project request, retain the user's original intent and send `coverage: "project"`. ProofKit also recognizes common whole-project phrases, but the host agent is responsible for faithful scope selection. A workspace-owned `.proofkit/workflows.yaml` can declare business workflows, source paths and Charter × surface checks. Use `inspect_test_scope({ includeSourceState: true })` to obtain the bounded Git fingerprint for that file, then inspect `workflowInventory` for missing links, stale source and exclusions. Its `candidateAudit` flags discovered entries or routes with no declared owner, no linked Charter route target, or overlapping exclusions; `partial` means the static candidate slice was incomplete. Investigate these locations before claiming the inventory is reviewed. With a matching fingerprint and compatible registered Charters, `run_test` without `charterId` or `suiteId` creates a project Mission directly from the frozen inventory. The default `core` executes each declared primary Charter/platform pair; `release` also replays each pair. MCP returns `readiness.acceptanceGaps` while allowing structurally ready checks to execute; those gaps still prevent a whole-project pass. Static candidates and a reviewer string do not prove completeness. Missing assertions or independent business proof still block automatic execution. An explicit caller choice of `declared` is recorded; never use it to silently narrow the user's request. Saved legacy gates require replanning and are not cleared by replay.

```javascript
run_test({ intent: "测试简历获取核心链路", level: "core", coverage: "declared", surface: "electron" });
run_test({ intent: "测试整个项目", coverage: "project" });
run_test({ intent: "上线前测试整个项目", level: "release", coverage: "project" });
```

The first call can run a ready registered or submitted workflow; the later calls derive the declared project matrix when its inventory and same-level Charters are ready, then report the remaining whole-project proof gap. `planning.coverage.inventory` is `bounded`, `partial` or `not-scanned`, and the plan's `workflowCoverage` is `unmeasured`; the result's `workflowExecution` contains the measured declaration checks. The agent must describe a passed declared test as the saved scenario's result and retain these coverage limits in its final explanation.

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
