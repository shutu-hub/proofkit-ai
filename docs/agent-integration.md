# Agent Integration

ProofKit is designed to be used by a coding agent. The user describes the behavior in natural language; the agent calls the ProofKit MCP server and receives a compact, evidence-backed result. The tested repository does not need ProofKit test code in its business modules.

## Recommended connection

Register one local MCP server for the project root. Codex, Claude Code and DeepSeek Harness can all use the same high-level tools:

```text
discover_project
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

The zero-code path only needs a local Web or Electron endpoint and a ProofKit config. Optional `.proofkit/integration.mjs` adds typed read-only capabilities, business Oracles and setup/cleanup for workflows such as resume acquisition. It is loaded as trusted project code and runs through the same lifecycle as CLI and MCP.

The integration should expose opaque IDs and sanitized facts. It should not expose arbitrary shell, SQL, filesystem or credential operations. Write capabilities require an explicit test environment, a Charter side-effect policy of `allow`, and the runner-level write opt-in.

## Choosing a level

| User wording | Level | Agent behavior |
| --- | --- | --- |
| “快速看一下登录页能不能打开” | `quick` | Run the shortest observable path and return quickly. |
| “测试简历获取核心链路” | `core` | Require an independent business result and retain replayable evidence. |
| “上线前完整回归 Web 和 Electron” | `release` | Run the release task matrix and block on missing negative-path or terminal evidence. |

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
