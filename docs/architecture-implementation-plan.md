# Unified controller implementation and cleanup plan

Status: stages 0–6 implemented and validated on 2026-10-04. Stage 7 has installed isolated-profile validation and measured product episodes; updating the occupied Ondřej Chrome profile remains pending. See the [delivery record](architecture-delivery-2026-10-04.md) for evidence, actual build identity, remaining deployment gate and bounded planning limitations. The [dated audit](architecture-audit-2026-10-04.md) remains historical evidence.

## Objective and constraints

Panel tasks, raw-goal MCP runs and supplied workflows must use one controller, one V2 observation/action contract and one outcome verifier. Existing public recipe tools remain compatible through translation, not through a second executor. Providers remain decision-only; browser execution stays in the extension, files and secrets in the host.

Preserve session/profile ownership, Safe/Takeover/read-only modes, exact document/origin binding, scoped files, vault grants, capture redaction, single-use plans and cancellation. Planning never grants access. Do not silently use another provider, activate vision or unlock the vault. No benchmark-specific selectors, answers or exceptions.

## Delivery order

| Stage | Deliverable | Dependency | Exit condition |
| --- | --- | --- | --- |
| 0 | Inventory, capability matrix and build identity | Audit | Actual installed engine/build distinguishable; active callers mapped |
| 1 | Canonical task/result contracts and shared run admission | 0 | Panel/MCP equivalent inputs resolve to equivalent admitted runs |
| 2 | Evidence, completion and data services | 1 | Generic predicates and exact data operations verified independently |
| 3 | V2 controller and capability registry | 2 | Supplied workflows preserve behavior using one state machine |
| 4 | Grounded raw-goal planning | 3 | Raw goals use the same engine; unsupported intents are explicit |
| 5 | Compatibility adapters and production cutover | 4 | All entry points use V2; no silent legacy fallback |
| 6 | Legacy deletion and repository cleanup | 5 | No obsolete execution path/import/build output remains |
| 7 | Installed validation and product benchmarks | 6 | Source/build/installed identity agree; publish failures and timings |

Use focused changes per stage. Do not combine the controller migration with a UI redesign, new secrets storage, dependency upgrades or unrelated refactors.

## 0. Inventory and execution identity

- Record callers of `run.start`, `browser_run_start`, `observe/manual/execute/step`, `v2.*`, `pageOperation` and `workflowChoices`: panel, MCP router, benchmark scripts, tests and docs. Classify each as active production, compatibility, test or obsolete; deletion requires evidence of its replacement.
- Create a capability matrix with separate executor, supplied-workflow and raw-goal support. Include permission, modality, provider restrictions, fresh evidence and test for every advertised operation.
- Reuse `execution.engine`, `contractVersion`, `goalPlanning` diagnostics. Generate build metadata once in `scripts/build.mjs` from package version plus a content fingerprint of relevant source/build inputs, including uncommitted changes. Do not use Git SHA alone as proof of installed code.
- Replace hardcoded host/MCP version strings in `host/service.ts` and `host/mcp.ts`; expose extension/host contract identity at handshake/diagnostics. Version compatibility must be explicit: reject incompatible protocol majors, report compatible build differences, and provide reload/reconnect instructions.

Gate: source identity and a running installed profile can be compared without secrets or page content. Existing compatible clients retain a defined behavior when new diagnostic fields are absent.

## 1. Canonical contracts and admission

Start from `browser-api.ts`, `capabilities.ts`, `shared.ts`, `host/broker.ts` and `host/broker-router.ts`. Search existing schema/helpers before adding files.

- Define normalized task intent: public goal, caller-authorized values/resources, required obligations, terminal predicates/answer specification, declared provider/model/modality policy and budget. Supplied workflows normalize to this intent; raw goals enter planning, not the legacy loop.
- Define phases: admission, observation, planning, decision, dispatch, verification, recovery, terminal. Preserve existing status fields; add structured phase/failure/evidence metadata without turning unknown dispatch into success.
- Centralize provider preference, input/budget validation and effective execution selection in shared admission. Keep transport-specific authentication and owner/session resolution at their current boundaries.
- Keep external resource authorization separate from model-produced intent. Ambiguous target matching requires fresh grounding; missing planning support is not `ask_user` for a nonexistent credential.
- Define budget accounting for planner and decision calls, reads, waits and actions. A single deadline starts at admission; no unlimited setup/planning stage. Report decision/action counts separately and define what consumes `maxSteps`.

Gate: contract tests for panel/MCP parity, invalid inputs, provider mismatch, read-only, revoked permission, concurrent active runs and cancellation during admission. No new client input can select a policy bypass.

## 2. Completion, evidence and data services

Extract behavior from `host/workflow.ts` and `host/run-controller.ts` into reusable services as needed; reuse `decimal.ts`, `record-collection.ts` and the canonical reader.

- Predicates cover checked/selected/value/enabled state, visible text, presence/absence, counts, navigation identity, downloads/uploads and compound requirements. Ordered obligations use verified action history; a final count alone cannot prove an operation sequence.
- Use fresh state and reader provenance for completion. Absence is only provable in a complete relevant scope; an unobserved/truncated frame is not proof that an element disappeared. Invalidate evidence on relevant document/state changes.
- Separate action outcome from overall goal outcome. Never ask the model to invent a receipt or select completion without the verifier's evidence.
- Consolidate table scalar/list/ranking/filter/aggregate handling. Use exact decimal comparisons, explicit locale, tie policy and original display values; avoid converting large values through `Number`. Add bounded row/column/page limits and complete-data requirements.
- Implement semantic waits on grounded predicates, within the remaining deadline. Treat ambiguous dispatch as verification/recovery, never automatic replay. Keep existing actionability and native-input protections.

Gate: regression tests for currency/locale/precision/ties, truncated data, stale refs, successful check/select/fill, asynchronous enable/remove, unchanged state, action sequences and unknown side effects. Test generic fixtures with changed labels/data, not only the online pilot pages.

## 3. One V2 controller and action registry

`RunController` retains lifecycle/ownership and delegates to one state machine. Extract from `executeWorkflow` by responsibility: observation, candidates, resource acquisition, evidence verification, recovery. Do not rewrite working file/vault/native integrations without need.

- Reuse V2 state/frames/read/plan/commit. Register capabilities with requirements, grounded candidate generation, execution and verification semantics. Explicit tool callers and autonomous candidates share action contracts, not necessarily the same UX.
- Generate bounded candidates for reads, navigation, controls, editors, scroll/native input, frames, artifacts, popups and site tools. Exclude denied origins/unavailable modalities before model selection; execution still independently enforces them.
- Track document-bound action history and task obligations. Stop immediately when verified complete. Refresh references after navigation or mutation; distinguish expected navigation from scope violation.
- Preserve safe resource acquisition, pagination limits, authentication handoff/resume and declared visual routing. Abort provider workers and pending execution on cancellation/revocation; release captures/artifacts/leases deterministically.

Gate: existing workflow, files, documents, auth, widgets, visual and site-tool behavior preserved. Independent page oracle verifies actions and terminal state. No supplied workflow executes through the legacy page path.

## 4. Raw-goal planning without hidden fallback

- Ground task intent against V2 observations. Plan through a bounded grammar and offered grounded choices that all decision-only providers can select. Retain evolving observations so delayed controls/frames can be grounded later.
- Support retrieval, declared ranking/filtering and state-changing goals, authorized literal input and bounded ordered actions. Text from a webpage cannot become caller authorization or a value instruction.
- Handle ambiguous/missing intent explicitly; report `unsupported_intent`, `ambiguous_target`, unavailable modality or actual missing authorization distinctly. Unsupported goals must not dispatch speculative writes.
- If unrestricted structured planning is needed later, introduce it as an explicitly declared planner capability and model policy. Jev's choice adapter cannot be assumed to emit arbitrary JSON; do not invoke Codex secretly for Jev runs.
- Supplied workflow and raw-goal planning produce the same normalized intent, registry and verifier. Remove `task:true` as an engine selector internally; retain its legacy input compatibility until documented retirement.

Gate: raw-goal tests through actual MCP and panel admission, with paraphrases, reordered controls, changed labels/amounts, delayed rendering, frames/shadow roots and prompt injection. Assert engine identity and dispatch outcomes. Include meaningful unsupported cases; never claim universal natural-language support.

## 5. Compatibility and cutover

- Translate legacy recipe tools to V2 at a compatibility boundary. Preserve old result shape where clients require it, while deriving it from canonical evidence. Preserve prepared action IDs, single use, expiry, document binding and explicit dispatch-only semantics.
- Migrate panel calls, internal runs, benchmark adapters and docs to canonical contracts. Remove production fallback to the old loop. During development, compare paths on isolated test fixtures; never shadow-execute writes in a user's session.
- Inventory external/public contract changes and document deprecations. Unsupported recipe behavior must fail explicitly, not disappear or route elsewhere.
- Validate built host/extension together, restart/reconnect with no active tasks, reload the installed unpacked extension and verify identity. Do not mutate browser profile storage or vault data to force migration.

Gate: native/managed/MCP/legacy tests, live installed smoke test, panel/MCP equivalent tasks and mixed-version failure handling. All autonomous results report the canonical engine. A deployment rollback reinstalls the previous compatible build; it is not a runtime silent fallback.

## 6. Cleanup inventory and deletion gates

| Candidate | Action | Required evidence before deletion |
| --- | --- | --- |
| Legacy loop in `host/run-controller.ts` | Remove algorithm; keep lifecycle or move it with focused tests | Retrieval and raw-goal parity, all callers routed canonically |
| `answerFacts`, `listAnswerFacts`, `relevantFacts` | Replace consumers with shared evidence/data service | Scalar/list/currency/precision/completeness tests pass |
| `host/task-inputs.ts` | Retire heuristic token-to-fill generation if no longer consumed | Planner retains literal authorization and sensitive-field rejection |
| `extension/page.ts` legacy observation/execution | Remove after recipes translate to V2 | No production/build imports; legacy public tools pass through adapter |
| Legacy branches in `extension/session.ts` | Remove snapshot/plan/execution duplication | Keep lifecycle, ownership, binding/navigation responsibilities still needed |
| `shared.ts` legacy snapshot/action/recipe types | Move compatibility types to adapter boundary; delete unused types | Host/extension/MCP builds and external contract checks pass |
| Duplicated run setup in broker/router | Replace with shared admission | Transport-specific owner/auth checks and parity tests pass |
| Large workflow function | Finish responsibility extraction; remove dead helpers/branches | Behavior parity; no second controller remains |
| Panel/manual tools and legacy MCP names | Keep compatibility or document explicit deprecation | Caller inventory and equivalent canonical route; not deleted just for being old |
| Benchmark/test scripts | Migrate active runners; label or archive historical reproducible ones | Current runner asserts engine identity; historical results remain interpretable |
| Tests tied to obsolete implementation | Replace with behavior/compatibility tests | Equivalent meaningful coverage exists before removing old tests |
| Build outputs and packaging references | Regenerate in intended output directory; remove obsolete bundle entries | Fresh build includes canonical modules; validate resolved cleanup paths |
| Docs/examples/comments | Update routes, limitations, versions and deprecation status | Examples match installed contracts; preserve dated audit/benchmark history |

Never include vaults, credentials, auth files, local profiles, generated MCP configuration or private raw reports in cleanup commits. Do not delete user tabs/groups: close only recorded task-owned resources after verified release. Do not delete native messaging, broker IPC or MCP because their transport code looks similar.

For every deletion change: targeted reference search → replacement behavior check → deletion → typecheck/build and affected boundary suites. Recursive filesystem cleanup requires a verified absolute target inside the intended generated workspace; no broad user-data cleanup.

Gate: architectural import checks prohibit autonomous legacy calls and duplicate execution entry points. A new capability must declare executor/workflow/raw-goal support, provider restrictions and a conformance test. Static checks supplement behavior tests; they do not prove runtime routing.

## 7. Validation, timing and publication

| Layer | Validation | What it proves |
| --- | --- | --- |
| Contracts | Unit/schema/admission tests | Input policy, budget, parity and accurate failure categories |
| Executor | Native, managed, MCP, compatibility and capability suites | Canonical actions and security/lifecycle boundaries |
| Controller | Workflow plus raw-goal fixture tests with independent oracle | Available actions, waits, verified completion and no unsafe replay |
| Installed product | Chrome profile smoke tests and runtime/build identity | Installed extension actually runs migrated code |
| Product comparison | Same tasks/budgets on official path, Jev and Codex | Measured product success and timing for declared configurations |

Run `npm run check` on implementation changes and the affected existing browser suites; run `test:native`, `test:managed`, `test:mcp`, `test:mcp-legacy` on boundary/cutover changes. Provider smoke tests use synthetic responses first; live calls only in explicitly scheduled product runs. Unit success is not a browser benchmark result.

Coverage matrix: navigation and recovery; tables/precision/pagination; forms/check/select; asynchronous UI; shadow roots/frames; editors/widgets; vision/native input/background tabs; files/downloads/documents; dialogs/popups; authentication handoff/vault scoping; multi-tab/profile ownership; site tools; cancellation/revocation/cleanup.

Freeze benchmark goals and scorer before execution. Record actual model, planner policy, engine/build identity, setup/decision/action/wait/verification/cleanup time and terminal evidence. Report success first, successful timing with denominator, failure-penalized timing and exclusions; do not count rapid failures as speed wins. Preserve the previous pilot and all failed episodes. Its quota-blocked iframe case needs a declared common environment replacement before the new run.

## Completion checklist

- [x] One canonical controller for supplied workflow and raw goal.
- [x] One canonical V2 executor; legacy public tools translate at the edge.
- [x] Generic grounded completion, exact data operations and bounded semantic waits.
- [x] No hidden provider fallback or implicit authorization from plans/page content.
- [x] Panel/MCP parity and accurate installed build/engine identity in isolated installed tests.
- [x] No stale production imports, bundle entries or obsolete tests after cleanup.
- [x] Capability matrix distinguishes execution from raw-goal planning support.
- [x] Existing security, cancellation, compatibility and cleanup tests pass.
- [x] Installed isolated-profile validation and unchanged product episodes recorded honestly.
- [ ] Latest host/extension build reloaded and attested in the occupied Ondřej Chrome profile.

The migration is complete only when these gates hold. Removing old files or passing helper tests alone does not complete it.
