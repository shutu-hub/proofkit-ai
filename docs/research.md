# Open Source Research Notes

ProofKit uses mature engines for surface control and keeps its own value in project understanding, business oracles, evidence and diagnosis. The projects below were reviewed for architecture and integration patterns. Their code is not copied into this repository.

## ego-lite

Repository: <https://github.com/citrolabs/ego-lite>

The useful design is the runtime contract around a browser session:

- `TaskSpace` isolates a task's pages, login state and ownership from the user's browser work.
- Stable page labels and explicit page adoption make multi-page tasks recoverable.
- Semantic snapshots expose role-oriented nodes and refs, while actions return an immediate receipt.
- A small JavaScript API lets an agent compose multiple actions in one round instead of repeatedly switching between shell calls and observations.
- Download, popup, dialog, event and hand-off lifecycles are explicit; CDP is available as a diagnostic escape hatch.

The boundary is equally important. ego-lite is a Chromium runtime and an agent Skill. It does not know that a resume belongs to a candidate, that an upload must reach a worker terminal state, or that a billing ledger must remain unchanged. Its receipt proves dispatch, not business success.

ProofKit reuses the ideas as `SurfaceAdapter` and `ActionReceipt` contracts. `TaskSpace` maps to a future isolated test profile; snapshot/ref handling stays inside an adapter; the Run and Evidence models add cross-layer events, redaction and independent oracles.

## Playwright

Repository: <https://github.com/microsoft/playwright>

Playwright is the first execution engine because it already solves browser process control, locator semantics, auto-waiting, frames, downloads, tracing, video and CDP. ProofKit should compose it, not fork it. The adapter hides Playwright types from the Runner so a future Maestro/Appium adapter can implement the same surface contract.

## Playwright MCP and CLI

Repositories: <https://github.com/microsoft/playwright-mcp>, <https://github.com/microsoft/playwright-cli>

They demonstrate persistent browser context, low-context tool calls and agent-friendly discovery. ProofKit takes the integration lesson: MCP is an alternate front end to one local Runner. It must not expose arbitrary shell, filesystem, database writes or unrestricted browser protocol calls as default tools.

## Midscene

Repository: <https://github.com/web-infra-dev/midscene>

Midscene combines natural-language actions/assertions, YAML task descriptions, cross-surface adapters, reusable Nodes and HTML reports. ProofKit borrows the Node idea as typed Domain Capabilities and keeps YAML as a reviewable Test Charter. Model output must pass the same Zod schema as hand-written plans; a model cannot skip side-effect policy or evidence requirements.

## Autonoma

Repository: <https://github.com/Autonoma-AI/autonoma>

Autonoma is useful as an example of typed commands, installer/runner separation, preview environments, video evidence, test data factories and pull-request feedback. Its license and cloud-oriented product assumptions make it a reference rather than a runtime dependency for a permissively licensed local-first project.

## Maestro and Appium

Repositories: <https://github.com/mobile-dev-inc/Maestro>, <https://github.com/appium/appium>

Maestro shows how a small CLI and accessibility-tree model make mobile flows approachable. Appium provides a broad native, hybrid, mobile Web and desktop driver ecosystem. The future mobile adapter should prefer Maestro for common flows and use Appium where driver coverage or native control requires it. Neither belongs in the Web/Electron first install.

## Keploy

Repository: <https://github.com/keploy/keploy>

Keploy's traffic capture and replay model is a good backend extension for deterministic HTTP, database and message fixtures. It should feed a Backend Observer or test environment, not become the control plane for UI and Electron tasks.

## BrowserGym and ARTEMIS

Repositories: <https://github.com/ServiceNow/BrowserGym>, <https://github.com/google-artemis/artemis>

BrowserGym contributes task environments and evaluation thinking; ARTEMIS contributes Android agent diagnosis. Their value to ProofKit is benchmark design and failure analysis, not a dependency in the first runtime.

## Reuse policy

1. Prefer a versioned upstream dependency when a project already owns a stable protocol or driver.
2. Copy concepts and contract shapes only when they fit ProofKit's evidence and safety model.
3. Preserve upstream licenses and attribution for any future code dependency.
4. Keep the product-specific layer in ProofKit: project map, charter, oracles, evidence, verdict and replay.
