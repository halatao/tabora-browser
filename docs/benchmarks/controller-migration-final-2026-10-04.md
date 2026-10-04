# Latest installed isolated validation — 2026-10-04

This is an isolated Chromium profile with the real unpacked extension, native
host, MCP and live decision providers. It is a development validation, not a
matched comparison against the official Chrome extension.

| Configuration | Strict success | Successful mean | Failure-penalized mean |
| --- | --- | --- | --- |
| Jev 1.13.0 | 5/9 | 3.52 s (5 tasks) | 55.29 s |
| Codex SDK gpt-6-luna | 7/9 | 10.00 s (7 tasks) | 34.44 s |

Version `0.5.5`, contract 2, fingerprint `57d461451fed283ea65dbe3e8fe3ddb36e539a88862a29d89dc0d326d0c50485`.
All 15 episodes that reached run admission attested matching host/extension
against this exact build. Three episodes failed loading before admission and
model inference. No build check was relaxed. All 18 episode-owned tabs/groups
were released; providers were restored.

Nine unchanged public goals, frozen original scorer, one repetition, 120 s
deadline. I09 is excluded for all lanes because of upstream editor quota.
Failures count as 120 s, never as speed wins.

Failures: both I01 and Jev I02 hit page readiness timeout before inference;
both I05 reject an unspecified confirmation predicate; Jev I10 declined the
offered answer. Luna completed the delayed enable/fill and both configurations
completed the ordered add/delete task. No benchmark answers/selectors were
introduced in production code. The unspecified-confirmation goal remains
unsupported; callers can provide an explicit workflow predicate.

The [earlier Chrome development comparison](controller-migration-2026-10-04.md)
records official 9/9. Its environment/build differs, so its times must not be
combined with these into a claim of matched superiority. Different success
denominators also prevent comparing successful averages directly.

Initialization mistakes and an outdated isolated broker were detected before
valid admission. Their failed attempts were retained, then a fresh independent
state directory was used for this cohort. The adapter now explicitly forwards
the operator environment and refuses installed build mismatch. Online loading
was unreliable also in a separate bare Chromium probe. This does not excuse
the three loading failures from the product success denominator.

[Sanitized episodes, hashes and preflight record](controller-migration-final-2026-10-04.json).
No vault bytes, auth files, profile paths or raw private page captures are published.
