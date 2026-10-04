# Original acceptance benchmark repeat — 2026-10-04

Same nine valid public goals, unchanged scoring script and 120 s deadline. Real installed Tabora through MCP, with live Jev and Codex SDK in a fresh isolated headless Chromium profile. No retries or changed goals. I09 remains excluded because of the upstream editor quota.

| Configuration | Strict success | Mean end-to-end |
| --- | --- | --- |
| Jev 1.13.0 | 9/9 | 6.180 s |
| Codex SDK gpt-6-luna | 9/9 | 7.318 s |

Build fingerprint: `3c6ff624a6094c6fd342a24ca51519daa215d10ec9614576e916ad044c7bbee8`.

Timing includes page opening, observation, model decisions, execution and terminal verification. Cleanup is excluded. The first Jev task took 32.000 s; it remains included. All 18 owned sessions were closed and the provider setting restored.

The official Chrome extension was not rerun in this cohort. These results cannot establish a matched speed comparison with the historical official lane. This is a developmental compatibility pilot, not independent WebArena or proof of broad production reliability.

[Machine-readable results](acceptance-repeat-2026-10-04.json)
