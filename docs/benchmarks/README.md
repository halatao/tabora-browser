# Browser benchmarks

Latest installed isolated acceptance rerun: [failure investigation and results](acceptance-2026-10-04.md).
Jev and Codex Luna each completed 9/9 unchanged valid goals. The previous failures
remain recorded. This is development validation in isolated Chromium, not a new
matched comparison against the official Chrome lane or a WebArena score.

Controller migration evidence: [development pilot and retained failures](controller-migration-2026-10-04.md).
It uses an intermediate build; latest validation and pending production deployment
are documented in the [delivery record](../architecture-delivery-2026-10-04.md).
The [latest isolated installed validation](controller-migration-final-2026-10-04.md)
records Luna 7/9 and Jev 5/9, with failures included. It is a separate environment
and must not be merged into a matched comparison against the official lane.

Latest measured comparison: [live Chrome rerun, 2026-10-04](chrome-comparison-2026-10-04.md).
Official extension plus the calling Codex agent, Tabora + Jev, and Tabora + Codex
Luna each completed 9/9 valid goals (means 15.07 s, 2.93 s and 7.23 s respectively).
Profile/cache equality is not attested; one development-exposed repetition does
not establish general stability or a speed advantage. It is separate from WebArena.
The [original failed online pilot](internet-2026-10-04.md) remains historical evidence.

## What we compare

The primary comparison is **the complete product a user can run**: official
ChatGPT/Codex browser control versus Tabora with a declared provider/model policy.
Different models are allowed. Model selection and text/vision routing are Tabora
features, not a fairness violation. Freeze the policy before evaluation; never
select the fastest model retrospectively for each evaluation task. Report each
fixed-model configuration separately, or test one predeclared routing policy.

A separate, optional executor comparison holds the calling agent/model constant
to diagnose browser transport and execution overhead. It cannot replace the
product comparison. Likewise, model decision time is not end-to-end task time.

## Independent primary workload

Use [WebArena-Verified](https://github.com/ServiceNow/webarena-verified), maintained
outside Tabora. Its upstream dataset and deterministic evaluators cover 812
tasks; the published Hard subset contains 258 tasks. Prefer the full dataset.
The complete Hard subset is an acceptable explicitly named smaller evaluation;
it is not a representative random sample of all 812 tasks.

Pin the upstream commit, exported dataset SHA256, evaluator version and container
image digests. Deploy the original application services and reset their state
before each candidate episode. Downloading the dataset or replaying reference
traces alone does not measure a live agent. Use the upstream evaluator unchanged
on the candidate's actual response and captured network evidence. Evaluator,
reference answers and reset controls belong to an operator the candidate cannot
access. A separate local directory does not enforce this isolation.

Run both products through their actual supported browser-control entry points
against these sites. An adapter only hands over the public goal, starts/stops the
clock, captures operator evidence and submits the final response. It must not
solve tasks, supply privileged DOM selectors, inject answers, or replace either
product's executor. If a connector only exposes an external agent driving the
official extension, name that exact configuration: it is not automatically the
complete ChatGPT product. Closed backend model IDs may be unavailable; record
the exposed selection, date and this uncertainty rather than invent an ID.

The current local BrowserGym bridge is an instrumented upstream integration,
**not a WebArena-Verified evaluator integration or a leaderboard submission**.
A development WebArena-Verified bridge now captures live HAR and invokes the
unchanged, pinned upstream evaluator (1.2.3). It currently deploys only the
original shopping-admin application and delivers RETRIEVE goals to Tabora;
it is not a complete 812-task runner. Failed setup/capture attempts are retained.
No matched official/Jev/Codex product score is available yet. Infrastructure,
all participant adapters, reset isolation and evidence must be verified before
publishing a product comparison.

See [development bridge](webarena-development.md) for implemented interfaces and
remaining limitations.

Use [VisualWebArena](https://github.com/web-arena-x/visualwebarena) separately for
visual workflows and [MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus)
for interaction diagnostics. Keep their native scores separate. Our local Browser
Capability Bench (BCB) complements these with extension capabilities, files,
background execution and safety contracts. BCB is authored by us: an independent
judge process and reusable protocol do not make it an externally authored benchmark.

## Protocol to freeze before a publishable product comparison

1. Publish the complete task inventory and configuration before evaluation.
   Develop model choice/routing on a disjoint development set; never tune on the
   evaluation outcomes. Declare any upstream overlap or prior exposure.
2. Compare the same tasks and initial site state on the same hardware, Chrome
   version, viewport, network and foreground/background condition. Use equivalent
   isolated profiles with only synthetic accounts/data. Keep vault off in the
   primary lane; test vault and assisted MFA separately.
3. Declare product/extension/host versions, provider aliases, actual reported
   models, reasoning settings, routing, budgets, cache policy and available tools.
   The official product keeps its own supported model policy. Product capabilities
   may differ; neither candidate may access the operator's judge or use a custom
   task-solving helper unavailable in the declared product configuration.
4. Run three fresh repetitions per task and candidate. Publish a seeded balanced
   AB/BA schedule before running, with equal first-position counts (within one
   episode for odd totals). Do not run candidates concurrently on the same machine.
   Persist every first attempt. No best-of sampling or silent retry. Warm-up tasks
   must be disjoint and excluded from scores. Declare cold/warm setup separately.
5. Use a common 600-second task deadline and 60 semantic browser-action limit
   for this proposed run. Freeze these values before collecting evaluation data;
   changing them creates a new protocol. One low-level mouse-down/up pair is one
   action; a compound call counts all semantic actions it dispatches. Record tool
   calls separately. If the closed product cannot expose/enforce action counts,
   use a separately named time-budget-only lane for **both** candidates.
6. The operator's monotonic clock starts when the ready candidate receives the
   goal, before task-tab/session creation or first inference. Stop at the declared
   terminal response or the common deadline. A candidate's completion claim is
   scored by the independent evaluator; a late successful write is a timeout.
   Include inference, observations, retries and task setup. Measure session/tab
   cleanup separately and always execute it; preserve user-owned tabs.
7. Publish success/coverage over **all** scheduled episodes, completion curves at
   30/60/120/300/600 seconds, and mean deadline-penalized latency (failure,
   unsupported and unassisted needs-user each cost 600 seconds). Show successful
   p50/p95 as conditional metrics, not an overall speed ranking. Report cost if
   observable; unknown cost is not zero. Report family/site and modality breakdowns.
8. Show paired success differences and task-cluster bootstrap confidence intervals
   for latency and success. A speed ratio on mutually successful tasks is secondary
   and must include its denominator. Keep all repetitions of a task in the same
   bootstrap cluster. Report invalid-environment counts and reasons separately.
9. Predefine environment invalidation (operator pause, broken reset, lost capture,
   incompatible runtime). Product errors/timeouts remain failures. Invalid pairs
   are not successes; preserve originals and rerun both sides under the same rule.
   Judge corrections change the evaluator version and require both-side reevaluation.
10. Publish sanitized episode outcomes/timings, configuration and schedule hashes,
    environment/evaluator identities, exclusions and evidence provenance. Keep
    private credentials, account identities and machine paths out. An external
    operator must be able to rerun both declared configurations; independent
    replication is stronger evidence than our own measurements.

This is a protocol specification, not a claim that these conditions have already
been met or that the upstream leaderboard accepts this submission format.

## Existing measurements: exploratory BCB pilots, 4 October 2026

The earlier broader pilot had 21 functionally confirmed areas for each executor,
including mandatory repeats, and 20 eligible timing pairs. Its official extension
median was 26.0 s and Tabora MCP median 32.8 s; means were 29.6 s and 34.5 s.
The **same external calling agent** chose actions on both sides; no Tabora SDK/Jev
decision model was invoked. C05 timing was excluded on both sides; C33 required
repeating both after an operator result-code error. Fixed execution order,
viewport drift and an unattested backend model make this exploratory, not a
strict product comparison. One run per area does not establish reliability.

The later internal-model text pilot tested five task IDs with two seeds (10
episodes per configuration). These use Tabora's installed extension and internal
decision controller. Only three task/seed pairs overlap with valid earlier
official timings: C01, C08 and C23, seed 101. The following is a **post hoc,
cross-run descriptive overlap**, not a preregistered independent product result:

| Configuration | Passed on overlap | Mean total task time |
| --- | ---: | ---: |
| Official extension + external calling agent | 3/3 | 35.029 s |
| Tabora / Jev latest | 3/3 | 5.311 s |
| Tabora / Codex Astra | 3/3 | 14.093 s |
| Tabora / Codex Luna | 3/3 | 14.151 s |
| Tabora / Codex Sol | 3/3 | 19.374 s |
| Tabora / Jev preview | 3/3 | 38.190 s |

Across all ten text episodes each: latest, preview, Astra and Luna passed 10/10;
Sol passed 9/10. Both Jev aliases reported `jev-1.13.0`; their timing differences
do not establish a version effect. The visual pilot tested C16 and W04 with two
seeds: each of the three Codex configurations passed 2/4. W04 exposed capture/
action pipeline failures. Later fixes have regression-test evidence, but these
measurements were **not** repeated on the final 0.5.5 build. Do not remove these
failures or market the text pilot as full-browser coverage.

[pilot-2026-10-04.json](pilot-2026-10-04.json) contains whitelisted episode data
and hashes of the private original reports; no traces, secrets or local profile
names are included. Original hashes identify source artifacts, but without those
artifacts do not independently prove their contents. This export supports
independent arithmetic, not independent replication of the runs. It is expressly
authorized public benchmark documentation; private runtime reports stay ignored.

Recalculate using Node.js already required by Tabora (no model or browser needed):

```powershell
node docs/benchmarks/summarize.mjs
node --test tests/benchmark-summary.test.mjs
```

The output includes every exported text/vision failure and labels the overlap
exploratory. Task/seed equality alone does not establish matched environments.
There is presently **no independently replicated claim that Tabora beats the
official product overall**. The available evidence motivates that comparison.
