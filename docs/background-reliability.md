# Background execution in 0.5.6

Tabora prepares the exact owned tab for observation, reading, capture and execution without activating it, focusing its window or restoring a minimized window. The implementation follows the [diagnostic plan](background-reliability-plan-2026-10-22.md).

## Operation lifecycle

Ownership, generation, policy and document checks surround a short CDP lease. Focus emulation and a fixed 1×1 screencast help a hidden renderer progress. A bounded probe checks newly executed animation frames; a cached screencast event alone is insufficient. The lease is released before model inference.

Readiness depends on the operation. DOM reads and controls use the live document, observed identity, hit testing and stable geometry. They report `backgroundReadiness.rendered: false` if animation frames did not advance; this does not imply that JavaScript, layout or text are inaccessible. Native preparation samples geometry across animation frames or a bounded 100 ms layout interval and revalidates identity before dispatch. This also covers adopted popup tabs whose compositor can stop despite a visible/focused document. The internal controller receives this metadata and excludes unsupported pointer choices while retaining semantic keyboard operations. Native mouse/hover/drag and image capture require confirmed paint progress and fail before dispatch/export when they cannot establish it. An MCP caller may explicitly prepare a fresh semantic DOM action after a confirmed `not_sent` refusal; this is not an automatic backend switch or replay. Work requiring a site's stalled animation callback can still time out; no synthetic business success is inferred from a click.

Attach, rendering, page animation-frame waits and debugger cleanup have deadlines. An attach completing after timeout is quarantined and detached without running the expired action. A failed detach prevents another operation from reusing that lease. Native dialogs retain their existing explicit handoff behavior.

For a normally auto-discardable tab, discardability is temporarily disabled during an interaction and restored afterward. This is scoped to the owned tab, is not a global Memory Saver change and does not promise to prevent freezing. Already frozen/discarded documents return `tab_frozen` / `tab_discarded` with `dispatch: not_sent`; Tabora does not activate or reload them automatically. A reload could destroy unsaved data or erase evidence of an uncertain write. Closed tabs and a terminated browser require a new explicit session/browser, or the existing managed headless installation path.

## Actionability and recovery

DOM click/check and native preparation share a two-second preparation budget for document overlays. The fast path has no fixed sleep. Every retry resolves the original observed identity again. Cancellation or a recycled target prevents dispatch. This wait occurs before side effects; native mouse/key sequences and uncertain writes are never replayed.

Hit-test diagnostics distinguish `overlay` from `outside_viewport` while retaining the compatible `target_obscured` public code. Modal errors include the blocking dialog. The executor does not remove nodes, disable pointer events or force-click through a blocker. Parent iframe hit testing remains part of native coordinate validation.

The internal controller receives bounded diagnostics in its decision history. It may offer a separate close action only for a uniquely observed informational dialog close button with no form/credential controls or confirmation/payment/loss indicators. Other blockers require inspection or a precise handoff. The original action always needs fresh observation and a new single-use plan. Existing repeated-action limits bound recovery.

## Diagnostics and interruption

Use `browser_diagnostics` with an owned `sessionId`. The buffer retains at most 100 bounded events for 15 minutes; it is in memory and scoped to that session. Export also has a 128 KB UTF-8 budget and declares `truncated` when only the latest events fit, so multilingual blocker labels cannot break native messaging. It contains no full DOM, field values, screenshots, credentials or URL query strings. Diagnostics can include trace ID, preparation phase, dispatch state, blocker identity, geometry and tab/window/document visibility. Interaction results include queue and CDP acquisition/render/operation/cleanup timing separately from executor verification timings.

`target_obscured` describes document hit testing. It does not establish that another desktop window is covering Chrome. Agents should inspect the blocker and fresh state instead of asking users to show Chrome automatically.

When the extension disconnects from a live broker, the broker retains an owner-only interruption record for up to 15 minutes. `browser_sessions` includes these records as `status: interrupted`; `browser_diagnostics` returns their cause and `dispatch: unknown`. Reconnecting a profile does not restore the old session or replay its actions. A full broker restart loses its in-memory records, and the MCP connection reports disconnection with an unknown dispatch warning. A new authenticated connection cannot adopt someone else's old session.

Cleanup failure is returned alongside a known action result as `backgroundWarning`, rather than replacing a successful dispatch with a misleading generic failure. Verification errors after a sent action preserve its dispatch status. The agent must inspect business evidence before considering another write.

Expanded native diagnostic fields are capability-negotiated: the host advertises `actionDiagnosticVersion: 2`. Until it does, the extension sends the original strict `targetId`/`blockers` shape. Error metadata travels inside the existing opaque `data.details` envelope, so hosts that reject a top-level `details` field can still read the packet and preserve the original error code. The new bridge also accepts the earlier top-level form. This preserves native contract 2 during a mixed-build update rather than making an older host disconnect on unfamiliar error fields. The workflow execution contract and observation schema remain version 2.

## Regression commands

```powershell
npm run check
npm run test:native
npm run test:managed
npm run test:mcp
npm run test:mcp-legacy
node tests/overlay-scroll-browser.mjs
$env:TABORA_BACKGROUND_REPETITIONS = '10'
$env:TABORA_BACKGROUND_PAIRS = '30'
npm run test:background
$env:TABORA_BACKGROUND_HEADFUL = '1'
$env:TABORA_BACKGROUND_IDLE_MS = '300100'
npm run test:background
```

Use an isolated test profile. Background integration tests count actual server writes, verify the witness tab remains untouched, and watch activation events throughout the operation. Performance samples exclude observation and model inference. Their p50/p95 values are executor measurements, not an end-to-end agent comparison. Reports and test profiles remain outside version control.

The full plan also includes OS foreground monitoring, forced worker/browser lifecycle transitions and a broader cross-profile stress matrix. Passing the existing browser tests does not establish every such scenario or diagnose the original work2 site without a fresh incident trace. Frozen/discarded states are deliberate explicit limitations in this release rather than silently handled through activation.
