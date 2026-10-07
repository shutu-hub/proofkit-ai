# Open Source Research Notes

ProofKit uses mature engines for surface control and keeps its own value in project understanding, business oracles, evidence and diagnosis. The projects below were reviewed for architecture and integration patterns. Their code is not copied into this repository.

The repository metadata and upstream READMEs were rechecked on 2026-10-07. The ego-lite page-ref registry, Midscene package layout, and Autonoma scenario/engine package layout were also inspected. The notes describe the current direction of the projects; their internal APIs can still change.

## ego-lite

Repository: <https://github.com/citrolabs/ego-lite>

The useful design is the runtime contract around a browser session:

- `TaskSpace` isolates a task's pages, login state and ownership from the user's browser work.
- Stable page labels and explicit page adoption make multi-page tasks recoverable.
- Semantic snapshots expose role-oriented nodes and refs, while actions return an immediate receipt.
- Its `PageRefRegistry` ties public refs to target, frame, backend node and document identity, and invalidates refs after navigation. ProofKit should use this as a design constraint when adding semantic refs rather than persisting CSS selectors as if they were stable identities.
- A small JavaScript API lets an agent compose multiple actions in one round instead of repeatedly switching between shell calls and observations.
- Download, popup, dialog, event and hand-off lifecycles are explicit; CDP is available as a diagnostic escape hatch.

The boundary is equally important. ego-lite is a Chromium runtime and an agent Skill. It does not know that a resume belongs to a candidate, that an upload must reach a worker terminal state, or that a billing ledger must remain unchanged. Its receipt proves dispatch, not business success.

ProofKit reuses the ideas as `SurfaceAdapter` and `ActionReceipt` contracts. `TaskSpace` maps to a future isolated test profile; snapshot/ref handling stays inside an adapter; the Run and Evidence models add cross-layer events, redaction and independent oracles.

## Playwright

Repository: <https://github.com/microsoft/playwright>

Playwright is the first execution engine because it already solves browser process control, locator semantics, auto-waiting, frames, downloads, tracing, video and CDP. ProofKit should compose it, not fork it. The adapter hides Playwright types from the Runner so a future Maestro/Appium adapter can implement the same surface contract.

## Playwright MCP and CLI

Repositories: <https://github.com/microsoft/playwright-mcp>, <https://github.com/microsoft/playwright-cli>

They demonstrate persistent browser context, low-context tool calls and agent-friendly discovery. The current README explicitly positions CLI + Skills for high-throughput coding-agent work and MCP for persistent state, exploration, self-healing and long-running workflows. ProofKit takes the integration lesson: MCP is an alternate front end to one local Runner. It must not expose arbitrary shell, filesystem, database writes or unrestricted browser protocol calls as default tools.

## Midscene

Repository: <https://github.com/web-infra-dev/midscene>

Midscene combines natural-language actions/assertions, YAML task descriptions, cross-surface adapters, reusable Nodes and HTML reports. Its current test-kit direction also includes lifecycle hooks, retries, project isolation/concurrency, API/data setup and cleanup, and generated Node references. ProofKit borrows the Node idea as typed Domain Capabilities and keeps YAML as a reviewable Test Charter. Model output must pass the same Zod schema as hand-written plans; a model cannot skip side-effect policy or evidence requirements.

Its current monorepo separates `core`, `web-integration`, `computer`, `android`, `ios` and `webdriver`. That supports keeping ProofKit's cross-surface contracts small while preserving adapter-specific behavior. Midscene's model-driven visual assertions remain useful for exploration, but critical business success needs a separate source of truth.

## Autonoma

Repository: <https://github.com/Autonoma-AI/autonoma>

Autonoma is useful as an example of typed commands, installer/runner separation, preview environments, video evidence, test data factories and pull-request feedback. Its license and cloud-oriented product assumptions make it a reference rather than a runtime dependency for a permissively licensed local-first project.

The package layout separates scenario management, web/mobile engines, test-suite state and analysis. It reinforces a first-class test run model, while its cloud and deployment assumptions are too heavy for ProofKit's first local install.

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

## Selection matrix

| Problem | Selected foundation | Reason | Explicit boundary |
| --- | --- | --- | --- |
| Web and Electron control | Playwright | Mature waits, locators, downloads, tracing and CDP | ProofKit does not fork browser mechanics |
| Agent-facing exploration | ProofKit MCP over Local Runner | Persistent run IDs and evidence are more useful than raw browser tools | Six high-level tools; no arbitrary process or file access |
| Natural-language UI actions | Optional Planner/GUI provider, informed by Midscene | Useful for discovery and visual cases | Model output must become a Test Charter or typed capability |
| Browser session isolation | Future adapter-owned profiles, informed by ego-lite TaskSpace | Prevents user tabs and test state from colliding | CDP attach is supported now; isolated attach profiles remain open work |
| Mobile UI | Maestro first, Appium compatibility layer later | Simple accessibility flows first; broad driver coverage later | Deferred until Web/Electron business slice is reliable |
| Backend traffic fixtures | Keploy-style capture/replay later | Makes async workflows repeatable | It is an observer/fixture system, not the control plane |

Repository checks on 2026-10-07: Playwright (~97k stars, Apache-2.0), Playwright MCP (~38k, Apache-2.0), ego-lite (~17k, MIT), Midscene (~15k, MIT), Keploy (~19k, Apache-2.0), and Autonoma (~241, nonstandard license). Stars indicate adoption, not test correctness; selection is based on the execution boundary and the independent evidence each project can provide.

The key product choice is a local CLI-first install with MCP as an optional connection. A developer can run `proofkit run` in CI, while an AI client calls the same Local Runner without a hosted account or a second execution model.
