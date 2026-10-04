# Failure investigation and installed acceptance rerun — 2026-10-04

This run verifies fixes for failures in the [previous isolated run](controller-migration-final-2026-10-04.md).
It preserves the original public goals and byte-identical scoring script.

| Configuration | Strict success | Successful mean | Failure-penalized mean |
| --- | --- | --- | --- |
| Tabora + Jev 1.13.0 | 9/9 | 6.59 s | 6.59 s |
| Tabora + Codex SDK gpt-6-luna | 9/9 | 7.42 s | 7.42 s |

Version `0.5.5`, contract 2, fingerprint `3c6ff624a6094c6fd342a24ca51519daa215d10ec9614576e916ad044c7bbee8`.
Both models use `workflow-v2`, grounded raw goals and the same V2 executor. No
model fallback, changed answers, benchmark selectors or relaxed evaluator.
Every episode checked installed extension/host fingerprints against this build.

## General causes and fixes

1. Opening waited for Chrome's full page load with a fixed 10 s timeout. In a
   bare Chromium probe the main response arrived in 536 ms but DOMContentLoaded
   arrived at 30.8 s. The page includes slow third-party script/resource loading.
   Readiness now verifies the actual HTTP document and completed DOMContentLoaded
   initialization, without waiting for unfinished images. The wait has a public
   1–60 s budget, default 45 s, capped by remaining overall benchmark budget.
   It does not bypass permissions or security interstitials. The cold first
   episode's loading time remains in its end-to-end time.
2. The bounded planner understood checkbox absence but rejected an unspecified
   affirmative confirmation. It now combines complete-scope absence, verified
   authorized action history and a newly visible standalone affirmative receipt
   from the same document. Old receipts, negative statements and unrelated prose
   cannot satisfy it. Other receipt semantics still need an explicit workflow.
3. The old body reader flattened shadow DOM without proving which root held a
   paragraph. Jev's refusal was a real model decision; there was no transport
   failure. Paragraph targets now include fresh document-local shadow-root
   ordinals, and scoped exact reads carry that evidence into answer choices.
   The model is still allowed to decline; its refusal is never overridden.

## Verification and retained attempts

TypeScript, 148 unit tests, 4 setup tests and build passed. A real extension/MCP
fixture waits for deferred initialization but binds while an image never finishes;
it independently reads paragraphs from open and closed shadow roots. MCP admission,
capability and background suites passed on the final build. Browser and workflow
suites passed on the preceding fix build; the later changes concern readiness only.

The first fix cohort was Jev 8/9 and Luna 9/9 (the old 10 s load limit still
failed Jev I01). The next cohort was 9/9 for both. Those intermediate results
remain in the JSON, including failures. A fixture diagnostic initially used
Playwright request routing for an extension-created first navigation; it served
the unrelated fallback JSON, so it could not test readiness. It was corrected
to use a real isolated HTTP server. That diagnostic is not counted as a product
episode or evidence of a product navigation race.

Earlier MCP admission and background tests each failed once while live benchmark
work was running: admission deadline and delayed navigation respectively. Both
passed when run serially. This is retained evidence of sensitivity to timing;
the final product cohort ran after integration suites finished. No test assertion
was relaxed and no input was replayed to hide a failure.

## Scope and timing

Nine valid tasks, one repetition, original 120 s deadline; I09's upstream editor
quota is excluded for all configurations. Real isolated Chromium profile with
the installed extension/native host/MCP and live Jev/Codex. The operator feeds
public goals only; the frozen scorer checks captured terminal/page evidence.
Cleanup is excluded from response time and reported separately. All 18 owned
tabs/groups were released, and providers restored.

The earlier official Chrome lane completed 9/9, but it has a different browser
environment and calling-agent model. This run does not prove matched superiority
or general production stability. The goals are development-exposed and locally
authored over The Internet; this is not WebArena or a held-out independent test.
The occupied Ondřej profile still needs the latest build reload and attestation.

[Sanitized episodes, phase metrics, source/build identity and scorer hash](acceptance-2026-10-04.json).
