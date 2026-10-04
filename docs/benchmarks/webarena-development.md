# WebArena development bridge

This is an integration smoke, not a publishable performance comparison.

## Implemented

- `browser_run_start({sessionId,goal,task:true})` preserves original public goals,
  enables bounded fills of observed fields using caller-supplied literals, and
  retains existing decision-only model selection and document-bound execution.
  Credential-like fields are excluded. No implicit submit is added.
- `scripts/webarena-installed-adapter.mjs PROFILE_ID` accepts a public JSON packet
  on stdin: `task_id`, `intent`, `start_url`. It creates an owned Safe session,
  runs the selected provider without fallback, returns a RETRIEVE response, and
  closes its created tabs on normal completion/failure.
- `scripts/webarena-provider.mjs` exposes operator status, set and restore through
  actual MCP. Configuration happens outside the episode clock.
- The separate Browser Capability Bench `integrations/webarena_recorder.py`
  records live traffic via a loopback proxy; its operator control is stdin.
  `webarena_evaluate.py` calls unchanged WebArena-Verified 1.2.3 with live HAR
  and the candidate response. `webarena_smoke.py` orchestrates development runs.

## Limits and publication gates

Only shopping-admin is deployed. The adapter formats scalar and structured list retrieval answers. Bounded list
candidates project complete observed table columns in displayed order or numeric
rank order, with explicit positive-value filter choices. Free-form generation and
mutation/navigation response types are not yet supported. The controller must gain these general
contracts before claiming complete WebArena coverage.

Private HAR may contain synthetic cookies and application data. Keep it and
operator config outside the public repository. Public goals are the only task
input to the candidate; operator evaluation outputs never enter its prompt.
Local process separation is not enforced oracle isolation.

Current smoke elapsed time covers the delivery process and its cleanup; it must
not be mixed with the preregistered response-only benchmark clock. One repetition
of three development tasks, fixed order, a shared Chrome profile and no full
state reset do not establish performance or reliability. Subprocess timeouts
require an additional scoped cleanup audit before unattended publication runs.

Run the original sites with pinned image digests, pin/hash public tasks, reset
before each episode, isolate evaluator access, implement the official extension
participant through its real entry point, and freeze model policies and schedule
before producing the matched comparison. Preserve failed runs and capture errors;
never treat setup errors as model timings or silently select successful retries.

## Development smoke, 4 October 2026

Original evaluator outcomes: official extension plus external agent 3/3;
Tabora Codex Luna 2/3; Tabora Jev latest (reported jev-1.13.0) 2/3.
The original Tabora runs failed multi-answer retrieval. A subsequent general
list-answer correction adds `answerValues` while preserving the string `answer`
contract. Repeated-run results are recorded separately; original failures remain. Raw timings use different clock boundaries, so no speedup claim
is valid. Sanitized episodes: [smoke export](webarena-smoke-2026-10-04.json).

After the list/ranking correction, both Jev latest and Codex Luna passed 3/3
in a new development smoke judged by the unchanged upstream evaluator.
[Separate corrected-run export](webarena-list-fix-2026-10-04.json).
This demonstrates the regression fix on this sample, not full WebArena coverage
or a statistically supported speed comparison.
