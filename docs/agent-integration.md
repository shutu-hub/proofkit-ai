# Agent Integration

ProofKit is designed to be used by a coding agent. The user describes the behavior in natural language; the agent calls the ProofKit MCP server and receives a compact, evidence-backed result. The tested repository does not need ProofKit test code in its business modules.

## Recommended connection

Register one local MCP server for the project root. Clients with MCP support, including Codex and Claude Code, use the same high-level tools. DeepSeek Harness can use this interface when its harness supports MCP, or invoke the CLI otherwise:

```text
discover_project
list_test_charters
run_test
get_mission_status
get_mission_evidence
cancel_mission
replay_mission
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

If a one-sentence request has no suitable Charter and the planner cannot supply an assertion or required Oracle, `run_test` returns `readiness.ready=false` and does not start the surface. The agent should use `list_test_charters` or `plan_test` and fill the missing test contract. Readiness checks structural prerequisites; they do not prove the assertion is meaningful.

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

The protocol deliberately separates the audit layers: `AgentStep` explains why a task was selected, `ToolCall` records the registered operation, `Observation` records typed facts, and `Evidence` points to artifacts that can be reviewed. The evidence response is bounded; large tool inputs and outputs remain in the local Mission file rather than being copied into every MCP response.

## Project onboarding

The zero application-code-change path needs a local Web, Electron or Appium-compatible mobile endpoint and a ProofKit config. A new project's test files default to `~/.proofkit/workspaces/<project-name>-<path-hash>/.proofkit/`. CLI `--workspace` and MCP `PROOFKIT_WORKSPACE_ROOT` select an explicit test workspace; `--root` / `PROOFKIT_ROOT` always identify the tested source. An existing project-local `.proofkit` remains compatible unless an explicit workspace is supplied.

Optional `<workspaceRoot>/.proofkit/integration.mjs` adds typed capabilities, business Oracles and setup/cleanup for workflows such as resume acquisition. It is trusted local code, not sandboxed JavaScript, and uses the same lifecycle as CLI and MCP. A business connector is needed when UI observations alone cannot establish the requested outcome.

For example, register `node /path/to/proofkit-ai/packages/mcp/dist/server.js` with the environment variables `PROOFKIT_ROOT=/path/to/source` and `PROOFKIT_WORKSPACE_ROOT=/path/to/test-workspace`. Once the local surface and business checks are configured, the agent calls `run_test` and receives a Mission ID instead of repeatedly supplying CDP instructions.

The integration should expose opaque IDs and sanitized facts. It should not expose arbitrary shell, SQL, filesystem or credential operations. Write capabilities require an explicit test environment, a Charter side-effect policy of `allow`, and the runner-level write opt-in.

For MCP, the operator sets `PROOFKIT_ALLOW_CAPABILITY_WRITES=1` when launching the server. The workspace must also set `policies.sideEffects: allow`, and the selected Charter and capability must each allow the write. The agent cannot turn on this process-level switch through a tool argument. CLI uses `proofkit mission run <mission-id> --approve --allow-capability-writes`. Use this only with a dedicated test environment and the integration's preflight checks.

## Choosing a level

| User wording | Level | Agent behavior |
| --- | --- | --- |
| “快速看一下登录页能不能打开” | `quick` | Run the shortest observable path and return quickly. |
| “测试简历获取核心链路” | `core` | Require an independent business result and retain replayable evidence. |
| “上线前完整回归 Web 和 Electron” | `release` | Run both surfaces and replay each; require the matrix and business evidence. Any negative or recovery cases declared in the Charter also run on every required surface; a case may declare an expected `failed` or `blocked` outcome. |
| “在 Android 模拟器上测试登录” | `core` | Use the configured `mobile` W3C WebDriver surface with the same assertions, Oracles and evidence contract. |

If the user does not specify a level, ProofKit selects `core`. An explicit `quick` request is never silently upgraded by the planner.

## CLI fallback

The same lifecycle is available without an agent:

```bash
proofkit mission create "测试简历获取" --surface electron --level core
proofkit mission run <mission-id> --approve
proofkit mission status <mission-id>
proofkit mission evidence <mission-id>
```

This is useful for CI, debugging MCP configuration, and reproducing an agent result locally. CLI, MCP and CI share the same Local Runner, Mission files and run evidence format.
