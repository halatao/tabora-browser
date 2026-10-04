# Architecture migration delivery — 2026-10-04

Follow-up acceptance fixes and latest installed evidence are in the
[failure investigation](benchmarks/acceptance-2026-10-04.md): both Jev and Codex
Luna completed 9/9 unchanged valid goals. Latest source/build fingerprint is
`3c6ff624a6094c6fd342a24ca51519daa215d10ec9614576e916ad044c7bbee8`.
The recorded migration build and its failures below remain historical evidence.
The production reload gate for the occupied Ondřej profile remains open.

Source implementation and cleanup are complete. Production deployment to the
occupied Ondřej Chrome profile remains pending: a foreign task is connected,
and reload/restarting its host would interrupt it. No foreign tabs/groups,
profile storage or vault data were deleted to force deployment.

## Delivered boundaries

- `run-admission.ts` owns panel/MCP run validation and provider preference;
  transport authentication and session ownership remain at their boundaries.
- `RunController` owns lifecycle, deadline, cancellation and metrics. Both raw
  goals and supplied workflows delegate to `executeWorkflow`, engine
  `workflow-v2`, contract 2. `task` no longer selects a different engine.
- Observation, candidates, exact readers, evidence facts and grounded raw goal
  planning have separate services. V2 state/read/plan/commit is the shared browser
  action contract. Completion is verified from fresh bounded evidence; model
  choice and dispatch alone are not proof of success.
- Raw goals use a bounded grammar. Missing support fails before speculative
  writes. Values come from the caller; page text cannot authorize values or
  enabling controls. Long readers and option continuations retain provenance.
- Public recipes translate through `legacy-recipes.ts`. Public shapes, bounded
  extraction, stale rejection and dispatch-only click semantics remain. Removed
  the old host loop, `host/task-inputs.ts` and `extension/page.ts`; compatibility
  types moved to `compatibility-contract.ts`. No autonomous legacy fallback.
- Credentials use an opaque scoped credential ID over `v2.credential`. HTTPS,
  unlocked vault, grant and observed unique form are checked; secret bytes do
  not enter model/MCP evidence. The public MCP contract now has 48 tools.
- Native modal handoff releases the debugger without waiting on commands that
  a blocked renderer cannot answer. Resume observes fresh state and never
  replays an uncertain write.
- Build fingerprints cover actual source/build inputs, including uncommitted
  code. Handshake rejects incompatible contracts; capabilities report host and
  extension identities. Benchmark admission rejects a stale installed build.

## Validation

Final build: version `0.5.5`, contract `2`, fingerprint
`57d461451fed283ea65dbe3e8fe3ddb36e539a88862a29d89dc0d326d0c50485`.

`npm run check` passed: TypeScript, 143 unit tests, 4 setup tests and fresh build.
All 13 integration suites passed: browser, native, managed, MCP, MCP legacy,
files, capabilities, background, widgets, visual, workflow, auth and WebMCP.
Tests use real installed extension/native/MCP boundaries, synthetic model
choices where specified and independent fixture/server oracles.

Actual panel and MCP admission completed the same already-satisfied public goal
with engine/contract parity and zero decisions/actions. Covered revocation,
owner isolation, stale references, exact decimal ranking, file scope,
credential privacy, asynchronous state, native input, image routing and
cancellation/release while a human prompt remains open.

The matched warm background executor fixture measured median wall time
203.44 ms active and 243.86 ms background (6 runs each). This excludes model
inference and is not a comparison against the official product.

## Product evidence and remaining limits

The [preserved intermediate development pilot](benchmarks/controller-migration-2026-10-04.md)
uses unchanged goals/scorer and reports failures and timing. Latest installed
isolated-profile episodes are [recorded separately](benchmarks/controller-migration-final-2026-10-04.md):
Codex Luna 7/9 and Jev 5/9 strict success, including loading failures. Fifteen
episodes reached admission and verified matching final build identities; three
failed before inference. All 18 episode-owned tabs/groups were released and
both isolated managed browsers were stopped. Different environments must
not be merged into a claim of matched product superiority.

General natural-language planning is deliberately not universal. Raw goals
cover bounded retrieval, all/both checkboxes, exact selects, single quoted public
fills and ordered actions with explicit terminal evidence. Vague confirmations,
general pagination planning, vision, files, site tools and authentication need
an explicit workflow or direct canonical tools. See the
[capability matrix](capability-matrix.md). No hidden Codex fallback for Jev.

Run metrics distinguish decisions/actions/reads/calls and phase time; phase
timings are attributed calls, not an independently profiled total decomposition.
`maxSteps` bounds decision cycles; waits remain bounded by the admission deadline.
Timeout is `run_timeout`; provider decline is `decision_declined`.

Deployment gate: once the foreign task releases control (or its interruption is
explicitly authorized), reload the extension, reconnect the matching host and
verify both fingerprints against the final build. Do not call this gate complete
based on source tests or the earlier installed build.
