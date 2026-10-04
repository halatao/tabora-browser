# Controller migration development pilot — 2026-10-04

This preserved intermediate migration run improved Tabora's strict completion from
the [previous pilot](internet-2026-10-04.md). It is development evidence, not a
held-out benchmark or a claim that the latest build outperforms the official product.

| Configuration | Strict success | Successful mean | Failure-penalized mean |
| --- | --- | --- | --- |
| Official extension + calling Codex agent | 9/9 | 20.08 s (9 tasks) | 20.08 s |
| Tabora + Jev 1.13.0 | 7/9 | 2.80 s (7 tasks) | 28.85 s |
| Tabora + Codex SDK gpt-6-luna | 6/9 | 6.24 s (6 tasks) | 44.16 s |

Build: `0.5.5`, `467eb867edbf39f1aa055a74bff017a4ddcc528a7810b8877197ddd37f39be7b`, contract 2,
`workflow-v2`. Each internal episode verified matching installed host/extension.
Actual models were `jev-1.13.0` and `gpt-6-luna`; no hidden provider fallback.
The original goals and scorer were unchanged. Nine valid tasks, one repetition,
120 s deadline; I09's upstream editor quota prevented a usable task for everyone.
Failed episodes receive 120 s. Successful averages use different denominators
and cannot be read as a matched speed comparison.

## Failures retained

- Both Tabora configurations rejected I05: the goal asks for an unspecified
  confirmation. The bounded grammar cannot safely invent its terminal text.
- Luna declined I06 after enabling the field. Later code makes the distinction
  between a provider decline and unsupported intent explicit and waits without
  asking the model repeatedly while a control is still disabled.
- Jev I08 was intercepted by another installed extension's action guard. No
  guard was bypassed. This is a product interoperability failure.
- Luna I08 reached the requested state but failed the frozen strict scorer:
  the trace used action type where the scorer expected semantic target kind.
  Later code records both fields. This episode remains a failure here.
- An official navigation attempt timed out before goal timing began. It was
  replaced by a fresh tab and is recorded as a preflight failure, not erased.

## Limits

These pages come from The Internet; the goals/scorer are authored locally. This
is not WebArena. The official lane uses its installed Chrome extension with the
calling Codex agent; its model is not independently attested. The developer has
seen these goals. Some episodes overlapped in system resource usage. Other
extensions were installed. All owned test tabs/groups were released; foreign
tasks and their tabs were retained.

The [sanitized episode report](controller-migration-2026-10-04.json) preserves
timings, outcomes and evidence hashes. The latest source is validated separately
in the [migration delivery record](../architecture-delivery-2026-10-04.md).
