# Decision runtime, 0.4.4

The extension owns browser execution. The native host owns provider authentication, optional vault access and the bounded retrieval loop. Decision adapters return one allowed operation/answer ID; they cannot execute arbitrary browser code or choose another model implicitly.

Since 0.4.1, Safe creates its own group in an existing normal window: the optional session `windowId`, otherwise the last focused normal window in this profile. A new window is a fallback only when no normal window exists. Safe still permits only tabs created by that session in its assigned window/group; putting an ordinary user tab into the group does not grant access. Different sessions can share the window but have separate groups. Explicit popup or incognito windows are rejected for Safe.

Since 0.4.3, Jev and SDK prompts share escalation guidance: uncertainty alone does not satisfy an `ask_user` criterion requiring a missing parameter, credential or authorization. This is guidance, not a guarantee that the selected model obeys the criterion. Menu descriptions retain up to 24 distinct nonempty descendant labels, including hidden submenu labels, and report when this list is partial. Goal-relevant navigation and submenu labels are ordered before the existing choice-count and description-length limits; this uses the supplied goal and observed labels, without site-specific routes or answers. Labels do not grant access or become executable targets while hidden.

The controller also observes and makes a fresh decision after `target_obscured`, with the same two-recovery budget as stale/unready targets. The executor emits this code only before dispatching a click. Unknown or timed-out write outcomes are still never replayed. These fixes do not guarantee correct planning: in a fresh three-task Jev pilot, search-term and invoice answers passed the upstream evaluator, but pending reviews still ended with an unjustified `ask_user` decision.

In 0.4.4, collapsed navigation hints use the control's `aria-label` or `textContent` instead of rendered `innerText`. CSS `visibility:hidden` made the actual Shopping Admin submenu names empty even though the DOM contained them; increasing the label limit in 0.4.3 could not recover empty strings. This change applies only to submenu labels. Extraction and answer evidence still use rendered text, and hidden controls are not offered as executable targets. The regression fixture includes a CSS-hidden submenu and checks that its destination appears as a hint but cannot be selected before opening the menu. A fresh Jev three-task extension/MCP pilot passed all three upstream evaluations; this is a regression result, not a general stability estimate. The controller still needs stronger distinctions between missing user input and planning uncertainty; the successful pilot does not establish that distinction for arbitrary tasks.

## Changes from 0.3

Observation includes document title/path, surrounding section headings, visible table previews, latent navigation-menu labels and explicit truncation. Tables with identical column headings remain distinguishable. Extraction reads the latest rendered data in the same live, bound element; mutation actions still verify their original fingerprint. Hidden cell content is excluded. Complete-table maxima and explicit page totals are evidence; a partial preview is not evidence of a global maximum or count.

`browser_step` consumes an existing prepared action once, waits for bounded DOM/navigation readiness, and returns a fresh observation and binding. It uses the existing executor and permission checks. Listeners are registered before the initial tab-state check. DOM readiness uses mutations, visible loading indicators and a short stability interval rather than a universal sleep or network-idle requirement. A changed page is not proof of business success. Unknown outcomes are surfaced, never replayed.

The local host controller removes per-step outer-chat orchestration. It offers navigation/read choices and grounded scalar answer candidates, delivers terminal answer/evidence, and enforces ownership, deadline, step and no-progress limits. Already-read targets and the inspect alias are removed until the document/page revision changes, so a model cannot repeatedly select the same unchanged read. It can recover pre-dispatch stale targets by observing and deciding again. It does not autonomously fill forms or synthesize arbitrary prose. It is not a replacement for a general MCP agent. Models can still make bad navigation or answer choices; bounded execution makes these failures observable rather than guaranteeing success.

Provider workers persist within one profile/session/provider, with configuration/credential fingerprints, a 20-runtime bound and 60-second idle expiry. Each Codex decision starts an isolated ephemeral thread in a reused App Server process. There is no conversation history shared between profiles or decisions. Overlapping calls within one scope fail explicitly. Cancellation, failed calls, profile revocation, model/configuration changes and vault mutations invalidate runtimes. Claude currently reuses the Node worker but not its per-query SDK child process.

## Codex context boundary

The pinned SDK/native runtime is 0.159.2. Disabling inherited MCP/plugins and individual instruction features is insufficient to establish a small prompt: the runtime can add personal instructions and `input.additional_tools` even when top-level `tools` is empty.

A per-decision local wire guard replaces all outgoing input/instructions with the supplied decision prompt, checks the exact selected model, installs its allowed-choice JSON schema, clears top-level and embedded tools, and rejects tool-call responses. Counts for the original and forwarded envelopes are exposed without their contents. Experimental App Server fields are supported by the installed runtime; omission from a stable schema is not proof that the runtime rejects them. Isolation is established by the tested outgoing envelope, not by those fields alone.

SDK account authentication remains inside Codex. Its opaque bearer is forwarded transiently to the validated official HTTPS Responses endpoint, with required client/account headers. No auth file is copied or global configuration rewritten. The localhost guard requires a random per-call route (or bearer in API-key mode), rejects browser Origin headers, accepts only its Responses POST, and refuses redirects. Backend streaming responses can lack a Content-Type header; a streamed request is still parsed and guarded as SSE, including split CRLF boundaries. HTTP and protocol errors remain distinguishable. This integration depends on the pinned runtime/backend contract and should be smoke-tested before upgrading it.

## Measurement and limits

Provider latency includes worker setup, IPC/adapter dispatch and failure teardown. `runtime.setupMs` includes directory/fork preparation and replacement of an old configuration; process initialization continues inside dispatch. There is no queue because overlap is rejected. App Server startup/thread/turn/TTFT are nested spans inside dispatch. Successful workers remain alive, so idle cleanup is outside successful call latency. `releaseMs` is thread unsubscribe, not worker destruction. `browser_step` separately measures action/wait/observe. Runs include their local orchestration and retain a bounded trace; exported live benchmark wall time additionally includes caller polling. Do not sum nested spans twice or infer cache hits from a reused PID.

Three retrieval tasks on one local WebArena site are a pilot, not a full benchmark or a stability estimate. The opt-in harness records failed runs as failures and freezes answers before upstream evaluation. It uses temporary browser/host state and does not change the user's selected provider. Claude is covered by synthetic SDK transport tests, not the measured WebArena comparison. Decisions API remains explicitly unavailable until its actual callable contract is verified. The separate AskJev integration's missing terminal answer cannot be repaired inside this repository.

The executor now also supports frame/shadow readers, redacted capture, trusted Chrome Input and typed workflows; see capabilities.md. They were not demonstrated causes of the older retrieval pilot latency. New benchmark measurements distinguish setup, controller, inference and shutdown; nested spans must not be added together.

## Inspiration

Design patterns were studied at pinned commits; no source code or dependencies were copied from these projects.

| Source | Pattern adapted |
| --- | --- |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp/tree/f183dad4a52965583e3cc1d59b88cdc279e2e57d) | Fresh observation after an action and meaningful snapshot context. |
| [agent-browser](https://github.com/vercel-labs/agent-browser/tree/d01253d9db28d75080e36da3c1c31ef89454731e) | Persistent scoped runtime and document-bound references. |
| [Stagehand](https://github.com/browserbase/stagehand/tree/a2387649bbb5f7e16df40fe67bd50a7d1e2011c8) | Distinct observe/act/extract responsibilities and bounded reads. |
| [browser-use](https://github.com/browser-use/browser-use/tree/4cbe921673b48a488f5415d9159249afd12a625b) | One bounded local loop with history and explicit completion. |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser/tree/24a14b76e14a9c30fd84878ca7985049d1e7d064) | Extension execution with progress and terminal states. |
| [Playwriter](https://github.com/remorses/playwriter/tree/33d5c5a2c5ebf702e387d94d609e038c98e0acec) | Stateful relay and scoped tab/session handling. |
| [mcp-chrome](https://github.com/hangwin/mcp-chrome/tree/f48e71751e00bc09725c7e173423cff4f2ccd12a) | Native bridge reconnection with backoff. |

Tabora retains its own exact-origin binding, single-use actions, Safe groups, profile ownership and vault grants. A broad Node/CDP evaluator or shared-tab policy from another project would weaken those existing boundaries.
