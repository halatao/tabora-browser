# Live Chrome online compatibility comparison — 2026-10-04

Real installed extensions in normal Google Chrome. Tabora was reloaded through Windows computer use and the old native broker restarted before evaluation; every internal episode attested host and extension against the build below. No isolated/headless Chromium results are included.

| Product configuration | Strict success | Mean end-to-end |
| --- | --- | --- |
| Official extension + calling Codex agent | 9/9 | 15.065 s |
| Tabora + Jev 1.13.0 | 9/9 | 2.927 s |
| Tabora + Codex SDK gpt-6-luna | 9/9 | 7.233 s |

## Per-task results

| Task | Official | Jev | Codex Luna |
| --- | --- | --- | --- |
| I01 | PASS / 6.995 s | PASS / 1.484 s | PASS / 4.625 s |
| I02 | PASS / 7.618 s | PASS / 1.328 s | PASS / 5.187 s |
| I03 | PASS / 10.444 s | PASS / 1.218 s | PASS / 5.125 s |
| I04 | PASS / 10.630 s | PASS / 1.406 s | PASS / 4.016 s |
| I05 | PASS / 17.036 s | PASS / 4.516 s | PASS / 7.625 s |
| I06 | PASS / 26.474 s | PASS / 5.235 s | PASS / 11.235 s |
| I07 | PASS / 21.816 s | PASS / 6.672 s | PASS / 9.813 s |
| I08 | PASS / 21.602 s | PASS / 2.907 s | PASS / 13.625 s |
| I10 | PASS / 12.971 s | PASS / 1.578 s | PASS / 3.844 s |

## Method and limits

Build `0.5.5`, contract 2, fingerprint `3c6ff624a6094c6fd342a24ca51519daa215d10ec9614576e916ad044c7bbee8`.

Same original public goals, byte-identical scorer, 120 s deadline, one repetition. I09 retains the previous upstream editor quota exclusion; it was not rechecked in this rerun. No model fallback or product-failure retries. Raw public goals only for the internal controller, without expected answers or scripted task steps. The scorer checks captured terminal outcomes and page evidence. All 18 internal owned tabs/groups were closed; prior provider/model settings were restored. Existing foreign tabs/groups were preserved after the authorized connection interruption.

The official lane ran immediately before this update, through the installed official Chrome extension plus the calling Codex agent. The two internal configurations then rotated per task in normal Chrome Ondrej. The official and Tabora browser profile identity/cache equality are **not attested**. No simultaneous paired run or randomized three-product ordering is claimed.

The clock includes opening the page, observations, model decisions, actions and a terminal response. Cleanup and provider configuration are outside it. Official calling-agent/tool orchestration is included, including a progress update during I06; its backend model is not attested. UI verification for official results is retained in the tool transcript, not separately persisted per-episode AX snapshots.

In this run both Tabora configurations and the official lane passed all nine valid goals. Tabora recorded lower mean times, but the profile/cache differences, development-exposed goals and single repetition prevent a general speed or stability claim. These pages come from [The Internet](https://the-internet.herokuapp.com/) ([upstream source](https://github.com/tourdedave/the-internet)); the goals/scorer are locally authored. This is a compatibility pilot, **not independent WebArena or a leaderboard result**.

The [original failures](internet-2026-10-04.md) and [isolated acceptance evidence](acceptance-2026-10-04.md) remain separate historical cohorts.

[Sanitized machine-readable results](chrome-comparison-2026-10-04.json)
