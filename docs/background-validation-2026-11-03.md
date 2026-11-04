# Background execution and updates: validation

**3 November 2026 · Tabora 0.5.6 · Windows · Chromium 153.0.8010.12**

The implementation and its limits are described in [Background reliability](background-reliability.md). These are local executor and transport regression results. They do not compare models or establish superiority to another browser extension.

## Results

| Check | Result | What it establishes |
| --- | --- | --- |
| `npm run check` | 176/176 unit tests; 4/4 setup tests; typecheck and build passed | Includes cancellation, ownership, bounded diagnostics, native compatibility, recovery and version checking |
| Native host | Passed | Real Windows native framing, DPAPI persistence, origin binding and redaction with synthetic credentials |
| Managed installation | Passed | Idempotent start, actual MCP → native → extension → DOM action, shutdown and persistent-profile restart |
| Two-profile MCP integration | Passed | Ownership, groups, modes, vault scopes, revocation, navigation, terminal-result polling and coordinated cleanup |
| Legacy MCP protocol | Passed | Real stdio with MCP 2025-03-26, including reconnect after broker restart |
| Update notice | Passed | A synthetic cached newer version produces a separate, once-only MCP notice and safe instructions; first-result JSON stays compatible |
| Existing older broker | Passed, read-only | The new MCP server returns `broker_update_required` and local instructions against the installed older broker |
| Capability integration | 35 checks passed | Includes 1,300-field continuation, controls, trusted input, readers, OCR, downloads, frame scope and popup execution |
| Capture guards | Passed | Changed private regions, new frames, target movement, scroll, resize and expiry fail closed |
| Frame-origin integration | Passed | Inherited blank/srcdoc access; opaque and ungranted foreign frames remain blocked |
| Overlay/scroll regression | Passed | DOM/native preparation waits through 100/700/1,800 ms overlays; cancellation and recycled targets prevent writes |
| Background, headless | Passed | Inactive-tab execution, untouched witness tab, real server writes, capture masks, competing-debugger refusal and navigation |
| Background, normal window | Passed | Also verifies minimized-window execution and execution after 300,100 ms idle without restoring/focusing the window |

The final native-error transport also passed a fresh full background smoke run with six active/background timing pairs. That run explicitly retrieved `browser_diagnostics` after a pre-dispatch debugger refusal and continued using the same owned session. Native host and legacy MCP checks were repeated after the transport change, as were managed installation and the two-profile integration.

## Matched executor timings

Thirty balanced warm pairs per browser mode. Wall time includes MCP transport, CDP acquisition, execution, verification and cleanup. Observation before planning and model inference are outside the stopwatch.

| Browser mode | Active p50 | Background p50 | Active p95 | Background p95 |
| --- | ---: | ---: | ---: | ---: |
| Headless | 220.2 ms | 238.1 ms | 278.0 ms | 389.6 ms |
| Normal window | 211.9 ms | 225.9 ms | 257.8 ms | 334.3 ms |

On this fixture, the background median increment was approximately 18 ms headless and 14 ms in a normal window. The first native commit after five minutes idle took **540 ms wall time**, with an inactive tab and an unfocused window, and produced exactly one verified server write.

The stress setting repeated DOM/native saves ten times each. Other background scenarios ran once per suite. These are small local synthetic pages; the numbers do not include a model, remote website latency or every combination in the original acceptance matrix.

## What the popup regression changed

A moved popup could report a visible, focused document while its compositor stopped advancing. Its DOM remained readable. The new execution path reports actual paint readiness and keeps semantic DOM/keyboard operations available. Unsupported native pointer input is refused **before dispatch**. The regression then prepares a fresh explicit DOM action and checks the independent server for exactly one saved record. It does not activate the popup, remove an overlay, blindly repeat an uncertain write or change the scorer.

## Build attribution and limits

The 30-pair measurements and long-idle run used control/rendering build `d505f5549fab5c384ecc2ab742ac75ea9d027b155ad5f1352cdd111277b2275c` of 0.5.6. Subsequent changes capped diagnostic export bytes and hardened the native-error envelope. Final build `4472af15a9c74cf83c6e1c6481d8ff32373c04179ce0a2db951beea393d88ff2` passed the unit/build checks and the targeted real transport/background reruns above. Both use native contract 2. Timing results must retain their actual build attribution.

Normal installed profiles were not reloaded by these tests. The specific work2 site incident remains unverified because that profile was not connected during this work. Chrome Stable, every OS occlusion condition and all forced lifecycle combinations in the original plan have not been exhaustively exercised. Frozen/discarded documents remain explicit limitations, and native pointer/image operations still require working paint progression.

Reproduce using the commands in [Background reliability](background-reliability.md) after normal host registration and Chromium installation. The optional 35-check capability suite also needs the sibling `browser-capability-bench` development fixture. Local raw evidence remains ignored under `reports/background/`, `reports/capabilities/` and `reports/mcp/`; it is not published as a full independent agent benchmark.
