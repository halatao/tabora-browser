# Full WebArena product comparison: preparation status

**Status on 4 October 2026: blocked before execution. No full score exists.**

The externally maintained [WebArena-Verified](https://github.com/ServiceNow/webarena-verified)
full dataset contains 812 tasks. The candidate configurations are the actual
supported official Chrome extension driven by an external calling agent, Tabora
with Jev latest, and Tabora with Codex Luna. This must not be described as an
attested ChatGPT backend-model comparison.

The [draft manifest](webarena-full-draft-2026-10-04.json) inventories all 812 task
IDs and site combinations; it schedules 7,308 episodes (three repetitions per
candidate). Seeded order is balanced: every candidate is first exactly once per
task. Public input, inventory, schedule and plan hashes identify the draft. It is
not frozen: models/builds, environments, operator isolation and clocks must be
verified before execution. Known development exposure (0, 77, 94, 127) is declared;
report its contribution separately, not as an unseen evaluation set.

The complete upstream Hard subset (258 tasks, 2,322 episodes) is a possible
separately named alternative. Never publish an arbitrary selection as either
complete upstream suite. The 600-second deadline gives a worst-case full-suite
budget of 1,218 hours before reset/cleanup overhead; it is not an expected duration.

## Concrete environment blockers

[Preflight evidence](webarena-preflight-2026-10-04.json) records the checks.

- Only the original shopping-admin application is deployed locally. All six
  original sites, including multi-site tasks, require reset and health checks.
- The official pinned setup lists map archives totaling **187,334,164,480 bytes**.
  The available disk had approximately **157 GB free**. Extraction, Wikipedia,
  container images and recording storage require additional space. No downloads
  were started that could exhaust the user's disk, and no unrelated data were
  removed. Use an adequately sized dedicated environment, or preinstalled sites.
- The documented Wikipedia data URL returned HTTP 403. HTTPS transport failed
  as well. A verified copy of the original ZIM or a working upstream source is
  required; a different Wikipedia snapshot changes the benchmark environment.
- Equivalent isolated extension profiles with vault off, a common monotonic
  terminal-response clock, and operator/oracle separation are not yet provisioned.
  The development runner's 300-second/30-step contract is not this protocol's
  600-second time-budget-only lane; it must not be reused unchanged.

## Implemented preparation and result checks

`scripts/webarena-publication.mjs` creates a deterministic draft from **public
agent input only**, and validates normalized operator episode records. It does
not deploy environments, run either browser product, reset sites, implement an
agent, or enforce process isolation. A frozen plan is an operator assertion;
this script is not independent attestation or a substitute for evidence review.

```powershell
node scripts/webarena-publication.mjs plan public-tasks.json plan.json
node scripts/webarena-publication.mjs report frozen-plan.json report.json records.json
node --test tests/webarena-publication.test.mjs
```

Outputs are exclusive-create: attempts are not overwritten. Keep private HAR,
credentials and evaluator answer data out of the public repository. Generate
`public-tasks.json` with pinned upstream `agent-input-get`; never pass private
reference answers to a candidate. Reproduction instructions must also publish
pinned image digests, dataset/evaluator hashes, product build hashes, Chrome
version, candidate budgets/routing/cache policies and neutral operator tooling.

Each record identifies a scheduled episode and plan hash, terminal outcome,
response and cleanup clocks, and evidence provenance. Operator terminal outcomes
are `passed`, `failed`, `unsupported`, `timeout`, or `environment_invalid`.
A successful record requires upstream verification and an evidence hash.
Product errors and unsupported capabilities count as failures. Environment
invalidation makes the report incomplete; preserve attempts and apply a declared
paired rerun rule rather than retaining only successes.

The report refuses headline scores for draft, missing or environment-invalid
runs, mixed clocks, duplicate episodes or unverified successes. Complete records
produce success over the whole scheduled denominator, successful p50/p95,
600-second failure-penalized mean latency, completion curves, separate cleanup
latency, and task-cluster bootstrap intervals against the official baseline.
Unknown cost stays null. No speed or reliability claim is made from three smoke
tasks or from this preparation work.

## Remaining work once infrastructure is available

1. Pin and provision all original services; verify reset and health for every site.
2. Provision equivalent isolated candidate profiles and enforce oracle isolation.
3. Implement the common delivery/terminal clock and scoped timeout cleanup in
   both participant paths; verify the official connector through its real entry.
4. Freeze the chosen complete suite, builds/model policies and schedule. Do not
   modify the evaluated product after observing test results within that run.
5. Execute every scheduled episode, preserve unsupported cases and failures,
   judge using unchanged upstream WebArena-Verified 1.2.3, review evidence and
   publish sanitized results plus site breakdowns and replication instructions.
