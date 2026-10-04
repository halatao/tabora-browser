# Browser capabilities and typed workflows

The extension owns observations and execution. The native host owns orchestration,
artifacts and secrets. Decision providers choose from bounded operation IDs; they
never receive a general browser executor, page JavaScript or CDP access.

## Observe, plan, commit

Use `browser_capabilities`, `browser_frames` and `browser_state` after attaching a
session. State V2 contains semantic names, roles, descriptions, section context,
disabled/readonly/checked/expanded/selected state, document identity and coverage.
Refs are opaque and document-bound. Continue through `coverage.nextCursor`; a
partial snapshot does not imply complete data. Provide `baseSnapshotId` to request
a delta. An unknown baseline returns a full snapshot.

`browser_plan` prepares one typed action for an exact `stateVersion`.
`browser_commit` consumes that plan once, revalidates identity, permission, geometry
and actionability, dispatches, and returns a new observation. An optional outcome
predicate verifies text, field state or another supported observed condition.
Dispatch, readiness and business outcome are distinct. A timeout or unknown write
requires observing the outcome before continuing; it never authorizes a replay.

Actions: DOM/native click; exact observed-link navigation; field fill; desired
checkbox/radio state; native select by observed indices; bounded scroll; native
hover and enumerated keys; contenteditable text-range replacement; trusted HTML
drag/drop; and capture-bound image coordinates. General JavaScript, raw CDP and
unobserved selectors are not accepted.

## Content and data

`browser_read` provides text, table rows/cells, stable records, native options,
aggregates and associated chart data. Text chunks carry revision and provenance.
Readers require exact continuity and stop on mutation or incomplete coverage.
Long identifiers stay strings. Decimal arithmetic uses integers and explicit
decimal/group separators, including values beyond JavaScript number precision.
Rows account for rowspan/colspan. Virtualized rows require stable record keys;
recycled nodes invalidate old action refs. Paging deduplicates by explicit keys
and requires a terminal disabled/missing next control; it does not treat a
preview as a complete table.

Frame discovery checks both browser host permission and the session's exact
origin grants. Nested/open/closed shadow roots and slots are traversed locally.
Denied frames are not read. Native frame coordinates use a browser-source-bound
geometry exchange; rotated or unsupported geometry fails before input.

Custom widgets use ARIA state and observed options, including visible proxy shells
for hidden named combobox inputs. The executor contains no site-specific selectors.
Rich-text edits preserve content outside the specified range. Complex editor
layouts whose rendered offsets cannot be mapped exactly are refused; this is not
a complete ProseMirror/CKEditor editing API.

## Native input and images

Chrome grants required `debugger` and `downloads` permissions at installation/update. The panel checks the actual grant and directs missing permissions to Chrome; `debugger` cannot be requested as optional.
The native input backend uses a fixed Chrome Input command list and a bounded
lease on the owned tab, with CDP focus/visibility emulation before preparation.
The real active tab, window focus and minimized state stay unchanged. Input and
capture share the lease through readiness. A one-pixel CDP rendering stream keeps
hidden frames available; its bytes are discarded locally and never exported.
The stream stops, emulation is disabled, and the debugger is detached afterward.
It emits trusted browser input, not OS desktop input. Losing
the observed element's focus or replacing a target stops the operation. A
competing debugger or unsupported focus emulation fails before input; there is
no automatic foreground fallback. DOM actions without debugger permission have
no visibility emulation. Expected
JavaScript dialogs require an exact type/message/origin authorization. Unexpected
dialogs, OS pickers and CAPTCHA/MFA require handoff.

`browser_capture` captures an observed owned region. Input fields, private regions
and frames are masked before capture, with mask/geometry revalidation. Image
bytes are explicit MCP output; they are not automatically sent to internal text
decision adapters. `image_click` is bound to that capture's document, viewport,
region and expiry. A changed layout/DPR invalidates coordinates.

`browser_document_read` parses a session-owned artifact offline. PDF text uses
PDF.js with evaluation/scripts/XFA/network disabled. Scans/images use local
English Tesseract OCR. Low-confidence OCR requires review; protected or oversized
documents fail explicitly. Parsers run in bounded subprocesses with time/input/
image/heap limits, not a hard operating-system RSS sandbox.

## Downloads, files and authentication

`browser_download` follows an observed link in the authorized task, waits for the
owned Chrome download, validates completion/size and stages immutable bytes.
Interrupted downloads are not completed artifacts. `browser_artifact_chunk`
returns explicit owned byte chunks; another session/connection cannot fetch them.
See [file-attachments.md](file-attachments.md) for roots, streams and upload limits.
Normal and hidden file inputs work without a picker or open panel. Native-only
uploaders, File System Access handles and OS file-dialog automation are unsupported.

Vault is off by default. Profile-only/shared entries still require this profile's
unlock grant and exact HTTPS credential binding. Passwords do not enter model
context or MCP outputs. `browser_handoff` stops agent input; `browser_resume`
revalidates the owned tab/origin and obtains new refs after a human completes MFA.
Neither operation bypasses authentication or solves CAPTCHA/MFA automatically.
Fresh state after resume includes trusted `humanProgress: {status:
"control_returned", reason: "mfa"}` outside page content. Internal decisions use
it to continue the remaining task instead of treating a mention of earlier MFA
as a new blocker. It does not prove authentication; visible OTP controls still
trigger handoff and the original business predicate must still pass.

## Internal workflows

All internal runs report `execution.engine: "workflow-v2"`, `contractVersion: 2` and
`goalPlanning: "grounded-goal"` or `"caller-workflow"`. Panel and MCP share run
admission. `task` remains accepted for compatibility and never selects another
executor. Public recipes translate through V2 at the extension boundary.

Raw goals use a bounded grounded grammar for retrieval, all/both checkbox changes,
exact options, one authorized quoted literal, and bounded ordered clicks with an
explicit terminal predicate. Unsupported or ambiguous intent fails explicitly;
see the [capability matrix](capability-matrix.md). Values and instructions from
page content cannot authorize a write. Other tasks need an explicit workflow or
individual tools. There is no hidden SDK planner or provider fallback.

Run status includes `phase` and `metrics`: decisions, action dispatch attempts,
exact reads, calls and time spent in each phase. `maxSteps` bounds decision cycles;
the final cycle may verify success but cannot dispatch another action. Pending
raw-goal UI transitions use up to 40 bounded 250 ms observations without a model
call, inside the overall admission deadline. `run_timeout`, `unsupported_intent`,
`decision_declined` and `outcome_not_met` are distinct. Unknown writes are never
replayed. Phase times exclude transport polling and must not be added to the
operator clock a second time.

`browser_capabilities.build` exposes host/extension version, content fingerprints,
contract compatibility and `sameBuild`. The extension rejects a missing or
incompatible host contract and displays reload/update guidance. Compatible
fingerprint differences remain visible; they do not grant capabilities.

`browser_credential_fill` accepts only an opaque credential ID, observed top-frame
form ref and state version. The host resolves the enabled, unlocked profile grant
and exact HTTPS origin; the extension validates the fresh form. The result reports
fill verification without submission. Password bytes never pass through MCP or
model context.

The calling agent may execute individual tools, or submit a bounded `workflow`
to `browser_run_start`. The same executor is used by Codex SDK, Claude SDK and
Jev. Decisions API remains unavailable until its actual transport is available.
Missing credentials, models or modalities never trigger a hidden fallback.

```json
{
  "sessionId": "SESSION_ID",
  "goal": "Fill Customer, attach contract.txt and Save once",
  "maxSteps": 20,
  "timeoutMs": 120000,
  "workflow": {
    "values": [{"field": "Customer", "value": "Ondřej"}],
    "attachments": [{"field": "Contract", "files": [{"name": "contract.txt"}]}],
    "success": {"name": "Receipt", "contains": "Saved"},
    "nativeInput": true
  }
}
```

File names must resolve uniquely inside preconfigured roots. The controller
imports immutable snapshots itself and does not give a provider filesystem
commands. A workflow can declare text edits, exact reads, document sources,
derived field values, drag destinations, downloads, expected dialogs, navigation
prerequisites and opt-in owned popups. Exactly one terminal contract is required:
success predicate, source-bound answer, or completed downloads. There is no
unbounded natural-language planner or model-generated arbitrary field value.
`logins: [{credentialId, origin, form?}]` selects an opaque exact-HTTPS vault
credential for one non-submitting fill. Only this profile's unlocked credential
scope is accepted. The model never sees the ID or password; normal observed
submission is separate. Never supply an OTP as a workflow field value.
Workflow credential IDs and exact origins are validated against this unlocked
profile's existing vault metadata before any model choice or browser action.
Actual credential use still revalidates the live document, origin and vault scope.

Verified credential insertion is reported as controller progress without exposing
credential bytes or claiming authentication. Detected one-time-code fields stop
the workflow before any decision or agent input. Human resume produces fresh refs
and trusted `humanProgress`, then the controller verifies the remaining terminal
predicate. Unexpected native dialogs likewise stop with `needs_input/needs_user`;
the workflow does not attempt another observation while a prompt blocks the page.
Only an exact task-preauthorized confirm/alert can be handled automatically.
Cancellation and release revoke local/host state without waiting for page scripts
blocked by a human-owned dialog; they leave the dialog open for the human.

The panel exposes a simpler action flow with field/model selects and a required
success confirmation; the full typed workflow contract is available over MCP.
Readonly allows reading, scrolling and direct observed-link navigation; it
rejects hover, click, fill, upload and site-tool dispatch.

## Experimental WebMCP

Enable site tools when creating the session and use a browser with native
`document.modelContext`. `browser_site_tools` discovers only the permitted bound
document. It treats page metadata as untrusted, validates a conservative recursive
JSON-schema subset, rejects external references and never fetches schemas.
`browser_site_call` uses a single-use tool ref and validated task-supplied
arguments. Timeout/abort returns unknown; the controller does not replay via the
site API or UI. No polyfill silently substitutes for native availability.

## Verification

`browser_session_open` with `waitForReady:true` checks the actual HTTP(S)
document, completed DOMContentLoaded initialization and matching current URL.
It does not wait for unfinished images/analytics after the document is usable.
`readinessTimeoutMs` defaults to 45000, accepts 1000–60000, and should be capped
by the caller's remaining overall deadline. It never bypasses site permissions,
redirect scope or browser security pages.

Observed shadow paragraphs include a document-local `shadowRootPath` of root
ordinals in composed scan order, for open and extension-readable closed roots.
These are structural evidence, not permanent selectors or access grants. Exact
paragraph reads retain target/document provenance, including slotted text.
Bounded raw retrieval can select a paragraph in an explicitly numbered root;
page-body lines alone cannot prove that structural source.

For supported disappearance goals, completion requires the authorized action
sequence, complete-scope absence, and a newly visible affirmative standalone
receipt in the same document. Pre-existing messages, negative wording and
unrelated prose are rejected. This is a bounded receipt grammar, not unrestricted
semantic verification; other confirmations need an explicit workflow predicate.

`npm run check` covers types, units, setup and the build. Real extension/MCP
integration suites: native, managed, mcp, mcp-legacy, files, capabilities,
workflow, widgets, auth and webmcp. Auth uses synthetic HTTPS credentials and
simulated human MFA in an isolated profile. These tests verify executor contracts;
they are distinct from model performance. The independent BCB checkout contains
36 capability families and 12 composite workflows, with unavailable provider/
modality and missing independent evidence reported explicitly.

## Internal input and image decisions (0.5.1)

Action workflows negotiate capabilities before their first decision. Omitted `nativeInput` uses trusted Chrome input; missing debugger permission produces a specific error before any write. Explicit `nativeInput:false` retains limited DOM semantics. Read-only workflows never enable writes.

`visual:{provider:"codex-sdk"}` explicitly authorizes image export for this task and selects that configured SDK/model for visual decisions; the text provider preference is unchanged. Omit provider to use the workflow provider. Optional `region:{name,section?,origin?}` chooses one observed top-frame region; the default is the observed Page body, clipped to the viewport. Fields/private regions are masked locally before bounded JPEG export. Images retain capture/document/snapshot identity, expire, and are not logged in run traces. SDKs receive actual image blocks; Jev fails with `provider_vision_unsupported` until its image contract is verified. Traces include actual provider, model, modality and nested observation time. Model family capability declarations are conservative and backend rejection is surfaced, not silently rerouted.

The image path selects existing typed operation IDs; it does not accept arbitrary code or unconstrained generated coordinates. Existing MCP capture-bound `image_click` remains available to a vision-capable calling agent.
