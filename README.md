# Tabora Browser

Local browser control for AI agents, through MCP. A Manifest V3 extension executes bounded DOM actions; a small local host routes profiles and optionally stores encrypted credentials. MIT licensed. Windows preview; Chrome, Edge and bundled Chromium. The extension UI is currently in Czech; MCP tool descriptions are in English.

## Benchmarks

See [benchmark methodology and measured pilot results](docs/benchmarks/README.md).
The [latest live Chrome compatibility comparison](docs/benchmarks/chrome-comparison-2026-10-04.md)
completed 9/9 valid tasks for all three configurations: official extension plus
calling Codex agent (15.07 s mean), Tabora + Jev 1.13.0 (2.93 s), and Tabora +
Codex SDK gpt-6-luna (7.23 s). One remote iframe editor remains excluded.
This is a single developmental run with locally authored goals/scoring; browser
profile/cache equality is not attested. It does not establish a general speed
advantage or production stability. The [original failed pilot](docs/benchmarks/internet-2026-10-04.md)
remains available as historical evidence.
The primary proposed product comparison uses the externally maintained WebArena-Verified
workload and its evaluator. Tabora may use its own declared model/routing policy;
fairness requires equal tasks and budgets, not identical models. Existing BCB
measurements are exploratory and include visual failures. Sanitized episode data
and a dependency-free script let readers reproduce the arithmetic. No complete
WebArena-Verified product comparison or independently replicated overall speed
advantage has been measured yet. The [full-run preparation status](docs/benchmarks/webarena-full-run.md) includes a complete 812-task draft schedule and the concrete environment blockers. It is not a completed benchmark or a score.

## Quick start

Prerequisites: Windows 10/11, Git and Node.js 22.13 or newer. Install in a permanent, user-owned directory; MCP and native messaging use its absolute path. No administrator rights are needed.

```powershell
git clone https://github.com/halatao/tabora-browser.git
cd tabora-browser
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1 -Managed -Client auto
```

This installs locked npm dependencies, builds the extension/host, registers the native host for the current Windows user, registers MCP with Codex and/or Claude Code when their CLI is on PATH, installs Playwright Chromium, and opens a dedicated `default` profile with the extension loaded and MCP enabled. A real stdio MCP handshake and profile discovery complete setup. Restart the MCP client to load the new server.

For an agent running without a visible browser, and with access to an explicitly selected site:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1 -Managed -Client codex -Profile work -AllowOrigin https://example.com -Headless
```

Use `-Client claude`, `both`, or `none` to choose registration. `auto` skips missing CLIs; explicitly requesting a missing CLI fails with instructions. Model API keys are **not required** when the calling agent chooses actions through MCP. Codex and Claude can use existing local SDK login; Jev reads TYPESAFE_API_KEY (or JEV_API_KEY). Provider API keys can optionally be stored in the vault.

The extension requests HTTP(S) access, debugger and downloads permissions during installation, so there is no per-site or runtime debugger setup in the panel. These support background/native input, screenshots and task-owned downloads. Chrome does not support `debugger` as an optional permission ([Chrome Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)); installation/update consent and enterprise policies still apply. Managed profiles inherit this default; passing `-AllowOrigin` restricts that managed copy to the listed sites. Multiple origins can be passed as a PowerShell array when invoking `./scripts/setup.ps1` directly. Chrome host permissions cover all ports on the specified hostname; vault credential use additionally checks the exact HTTPS origin including port. The browser helper uses normal TLS verification.

## Managed profiles

```powershell
npm run browser -- start --profile work --allow-origin https://example.com
npm run browser -- status --profile work
npm run doctor -- --require-profile
npm run browser -- stop --profile work
```

Each name gets a separate persistent Chromium profile and extension identity within that profile. Repeating start returns the running instance. To add a permitted origin, stop the profile and start it again with `--allow-origin`; previous origins persist. First setup enables MCP; later starts preserve a user's disabled MCP setting. Use `--enable-mcp` explicitly on a stopped profile to enable it again. To change a managed restriction, stop the profile and update its local `config.json`, then restart. An empty origin list uses the extension’s default HTTP(S) access.

The browser runs as a background Node process until stopped or its window is closed. Control uses a local Windows named pipe, with no remote debugging TCP port. Stop targets only that managed profile. Do not use a managed profile directory with another browser process.

## Existing Chrome / Edge profile

Run setup without `-Managed`, then:

1. Open `chrome://extensions` or `edge://extensions` in the intended profile.
2. Enable Developer mode, choose **Load unpacked**, and select this checkout's `dist/extension`.
3. Open Tabora’s side panel. Connection starts automatically; new profiles enable MCP, use Safe mode, and keep the vault off. Chrome handles the required permission consent when installing/updating the extension. The panel checks the actual grant; if permissions are missing, **Otevřít správu rozšíření** leads to Chrome for a reload/re-enable and any required consent. It never retries a runtime debugger permission request.
4. Run `npm run doctor -- --require-profile`.

Repeat the load steps for other browser profiles. The name is read from Chrome/Edge profile metadata when exactly one matching installed profile can be identified. Chrome does not expose the display name directly to extensions. If multiple profiles match, a one-time profile selector appears directly in the panel; Tabora does not guess from “last used”. Managed profiles use their launcher name. Existing explicit MCP revocation is preserved; a paused profile offers an explicit reconnect button. Their profile IDs are distinct. This project is not published to the Chrome Web Store; it does not silently install into ordinary Chrome profiles or bypass browser policy. [Chrome installation rules](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions) explain that boundary. The automatic route follows [Playwright's Chromium extension support](https://playwright.dev/docs/chrome-extensions).

## Three browser modes

The main panel contains only the mode, provider/model selects and vault switch. Codex/Claude use existing SDK login and Jev uses the environment key automatically; selecting a provider loads its catalog and saves a valid default model without a separate connection step. An existing explicit vault connection is preserved. Missing login or credentials appear inline. Vault management appears only when enabled, pending file requests only when needed, and Stop only while a session exists. Manual workflows, connection overrides, MCP revocation and diagnostics remain available through Chrome's **Extension options** (`panel.html?tools`), outside the normal side panel. Both views use the same controller and validated runtime commands.

| Mode | Behavior |
| --- | --- |
| Safe (default) | First open creates a named group in the last focused normal window (or the explicitly selected window). Later opens reuse that window/group. A new window is created only when no normal window exists. Existing tabs, other sessions’ tabs, and tabs moved out of the group cannot be controlled. |
| Risk / Takeover | The agent can attach existing HTTP(S) tabs. Session ownership still prevents two clients controlling the same tab. |
| Read only | Existing tabs can be attached and visible page text/tables extracted; click, fill and login recipes are rejected. |

Safe shares the current profile’s cookies and website login; it is not incognito or a separate account sandbox. Read only prevents Tabora actions from changing page content, not the site’s own JavaScript/network activity. Changing modes invalidates prepared actions and document bindings. Disabling the vault revokes credential access and locks this profile’s grant without deleting saved secrets. The main Stop button cancels all sessions in this profile.

The vault switch is off for new installations and migration from profiles without the switch. Enabling it reveals vault management; unlocking is a separate explicit action. MCP and site consent are independent of vault access.

## MCP clients and actions

The setup script uses the clients' supported registration commands. For other stdio clients, merge the generated, git-ignored `mcp.config.json` entry into their configuration. It points to the installed Node executable and `dist/host/mcp.js`; do not commit this machine-specific file. This is a local stdio server, not a hosted URL usable directly from a cloud ChatGPT connector.

References: [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude Code MCP](https://code.claude.com/docs/en/mcp).

The server exposes 48 tools, including versioned state/actions, readers, documents, captures, attachments and provider/model selection. See [capability contracts](docs/capabilities.md). Typical flow for a calling agent:

1. `browser_profiles` → choose a profile ID; `browser_tabs` lists its tabs.
2. `browser_session_create` with a meaningful task name.
3. `browser_session_open` opens a link in that session’s named tab group (in an existing window in Safe). Set `waitForReady: true` to wait for loading and attach the exact document. In Takeover/Read only, `browser_session_attach` can bind a selected existing tab.
4. Check `attached` and any returned error code before continuing; opening a tab is not proof of attachment.
5. `browser_observe` with recipe `all`, `click`, `fill`, `login`, or `extract`. Read only permits read observations; login requires the enabled/unlocked vault. Observations include section headings, rendered table previews, paths, page identity and truncation flags.
6. The agent chooses a target and calls `browser_prepare`. Alternatively `browser_decide` asks one of the configured decision adapters.
7. `browser_step` with the single-use action ID and `stateVersion = documentId + ':' + documentToken` performs the action, bounded readiness wait and fresh observation together. It rebinds a navigated document only in the same owned tab and exact origin. `browser_execute` remains available for dispatch-only compatibility.
8. When finished, call `browser_session_release` with `closeCreatedTabs:true`. It closes still-owned tabs created by this session in its original group/window; Chrome removes an empty group. Attached user tabs, moved tabs and groups containing user tabs stay open. Check `failedTabIds` for cleanup failures. Omit this flag when handing off a page the user needs to keep.

Interactive actions run in the owned tab without activating it, focusing its window or restoring a minimized window. With Chrome-granted `debugger` permission, a tab-scoped [CDP focus emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setFocusEmulationEnabled) makes the target renderer act focused/visible during preparation, dispatch, readiness and fresh observation; it is disabled and detached afterward. Native input and target screenshots reuse this lease. [Playwright uses the same protocol primitive](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crPage.ts). Ordinary DOM actions still work without debugger permission, but visibility/focus-sensitive sites then have no emulation guarantee. A competing debugger or unsupported emulation fails before dispatch; Tabora does not silently switch to foreground execution or detach another debugger. Element focus, ownership, mode, cancellation and exact document binding are still checked. Reads do not acquire this lease. One executor interaction remains serialized per profile through readiness; concurrent model inference is independent.

Focus emulation alone can leave Chromium's hidden compositor throttled. During the same short lease, a fixed `Page.startScreencast` stream constrained to one pixel keeps rendering frames available. Its bytes are discarded locally; they are never stored, logged or passed to a provider. The stream is stopped before focus emulation is disabled and the debugger is detached. When an unhandled human dialog blocks renderer commands, the lease detaches directly without waiting for those commands or answering the dialog. Actual user-requested captures remain separate, region-bound and pixel-redacted. See [background execution](docs/background-execution.md) for contracts and evidence.

Use `npm run test:background` to verify actual MCP/extension execution against inactive and minimized tabs, including trusted mouse/keyboard/drag events, animation-frame readiness, navigation and pixel-redacted screenshots. Set `TABORA_BACKGROUND_HEADFUL=1` to test a normal browser window too. The test launches plain Chromium without global background-throttling flags and connects with Playwright `noDefaults: true`, so its default focus emulation cannot supply the feature being tested. It reports matched warm executor timings separately from model inference and external agent benchmarks. Browser/OS permission prompts, native dialogs, frozen/discarded pages and anti-automation behavior remain distinct limitations; this is not a guarantee that every site supports invisible execution.

Native select observations expose bounded option labels, original indices and selected/disabled state, never their internal HTML values. Prepare `recipe: 'fill'` on the select target with `selectOptionIndex` from that observation; do not combine it with `fields` or another recipe. The document-bound executor resolves the index locally and rejects changed options and disabled choices. Existing explicit `fields` filling remains compatible.

`browser_sessions`, `browser_cancel`, and `browser_vault_list` support inspection, cancellation and credential metadata. Each MCP connection owns its sessions; one session owns an attached tab. Different sessions/profiles can work concurrently. Navigation invalidates prepared actions; outside `browser_step`, reattach and observe. If the host restarts, MCP stdio stays alive and reconnects on the next request. The extension reconnects with bounded exponential backoff. Existing sessions are lost; discover the profile and create a new session. In-flight actions fail without automatic replay. A readiness transition is not proof of the intended business outcome. Do not automatically retry ambiguous actions.

For a local retrieval task, select a provider/model and enter a URL and goal. Raw goals and supplied workflows now share the canonical V2 controller. Raw planning is bounded; see the [capability matrix](docs/capability-matrix.md) and [migration validation record](docs/architecture-delivery-2026-10-04.md). For general tasks, the connected agent can use versioned `browser_state` → `browser_plan` → `browser_commit`, exact readers, or a typed `workflow` passed to `browser_run_start`. The workflow supports task-supplied form values, text edits, data/document extraction, exact aggregation, scoped autonomous files/uploads, downloads, drag/drop, dialogs and owned popups. Completion requires fresh source-bound answer or business evidence. Poll `browser_run_status`; cancel with `browser_run_cancel`.

Providers choose bounded operation IDs; the extension executes. Internal workflows use trusted Chrome input by default and fail with native_input_permission_required if Chrome has not granted the required debugger permission. Reload/re-enable an updated extension through Chrome and complete any installation/update consent; this permission cannot be granted by a runtime panel request. Explicit nativeInput:false opts into the limited DOM backend. No fallback replays an uncertain write. For visual tasks, workflow.visual explicitly authorizes a masked top-frame capture and may select a separate provider (for example Jev for text and Codex SDK for images). Codex/Claude image adapters accept bounded real image blocks; provider/model support is checked before execution. Jev image support remains unverified and is rejected explicitly. The calling MCP agent can also explicitly request redacted images and use its own vision capability. There is no unbounded planner or free-form generation of field values. See [workflow example, capabilities and limits](docs/capabilities.md).

Runs report engine/build identity, phase timings and separate decision/action counts. They stop on deadline, bounded steps, unsupported intent, missing input or no progress. Mode/provider/access changes revoke prepared actions and runs. An uncertain write is never replayed automatically. Handoff/resume obtains fresh refs after user intervention.

## Automatic local attachments

The connected MCP agent can find a file, import or stream it, and attach it to a website without a picker, per-file confirmation, or an open side panel. Vault can stay off. Set `TABORA_FILE_ROOTS` to a JSON array of allowed absolute directories in the MCP server environment, or pass `-FileRoot` to setup. Without an override, a directly launched MCP server grants its working directory; the generated `mcp.config.json` explicitly grants this checkout. No whole-disk permission is implied. These roots are set by the authenticated local client at connection, not by a model tool argument or web page.

Flow: `browser_files_roots` → `browser_files_find` (filename substring, bounded traversal) → `browser_files_import` (fileRef or exact granted path) → `browser_observe` (`all` or `fill`) → `browser_upload` with observed file target, artifact IDs and exact stateVersion. For an already known file, skip finding. Choose the file from the actual task criteria, not an arbitrary first match. Upload follows the same profile/session/tab/document/site permissions as other writes; Read only rejects it.

An agent that already has the bytes can instead use `browser_files_begin` → sequential `browser_files_chunk` → `browser_files_finish`. Streamed attachments do not grant the host access to their original source path. Chunks are at most 32 KiB decoded; files at most 50 MiB and a session at most 100 MiB / 20 artifacts. All files are snapshotted and SHA256-checked; the original is never modified. Artifacts are private to the MCP connection/profile/session and expire after 15 minutes. Cancel/release, profile policy changes or disconnection revoke access. `browser_files_status` returns metadata only; `browser_files_release` deletes staged copies.

`browser_upload` assigns a FileList and dispatches synthetic input/change in the exact document. It supports ordinary file inputs, including hidden uploader inputs, with accept/multiple checks. It can trigger the site's upload handler, but returns **attachment dispatch**, not server success. Observe the application's result or submit using normal browser actions. Unknown writes are never replayed. Native-only upload widgets, website File System Access pickers and OS dialogs remain unsupported; granted debugger permission enables trusted pointer/keyboard input, not OS file-dialog automation.

`browser_files_request` is an optional manual handoff. A request appears in the side panel, where the user can pick or cancel a file. It is not part of the autonomous path. Extension options also support manual attachments and drag/drop. Internal typed workflows can discover an exact filename inside configured roots and upload it without the panel. The connected MCP agent can also import/stream and upload directly.

For details, see [attachment contracts and limits](docs/file-attachments.md). Run `npm run test:files` for real extension/MCP upload checks against an independent local upload oracle.

## Optional vault and decision providers

Vault is off by default. Setup and explicit unlock happen in the extension panel. Credentials can be shared across profiles or restricted to one profile (the default). Each profile has its own unlock grant and timeout. Website login uses a credential ID and fills only the bound exact HTTPS origin. Passwords and provider keys are not returned through MCP or sent to decision models.

The vault uses AES-256-GCM with a Windows DPAPI-protected key. It is local to the Windows user, with no biometric challenge, cloud sync or cross-machine recovery. Profile scoping is enforced by the application; it is **not** a security boundary against arbitrary processes running as the same Windows user. Deleting the encryption key can make saved credentials unrecoverable.

| Decision adapter | Status in this repository |
| --- | --- |
| Codex SDK | Persistent local authenticated App Server from the pinned SDK package; isolated ephemeral threads. A local wire guard replaces inherited instructions/input and both tool encodings with the exact decision prompt and selected model. Optional API-key route uses the same guarded Responses boundary. |
| Claude Agent SDK | Existing local SDK login or optional API key; external tools and inherited MCP disabled. Node workers are reused; the Claude query subprocess is still started per decision. |
| TypeSafe / Jev | System One choice adapter; system environment key or optional vault key. |
| OpenAI Decisions API | Explicit unavailable placeholder pending a verified API contract; no substitute model |

Select a provider, connect its SDK/catalog, then select a model. No free-text model field is used. Codex model choices come from App Server model/list; Claude from supportedModels(); Jev from its authenticated /v1/models. Optional Codex API-key mode lists text-model families from the OpenAI API catalog. A catalog is not proof of entitlement or structured-output compatibility; the first decision validates actual access. Catalogs are cached for five minutes and the Connect button refreshes them. SDK authentication remains with the local provider client; Tabora neither imports credentials into the vault nor unlocks it automatically. If the SDK reports login_required, sign in through that provider’s local client and reconnect.

The default **Connected agent / MCP** provider lets the calling agent choose via browser_prepare, avoiding an extra model call. browser_profiles returns activeProvider as the profile’s preference; an explicitly supplied browser_decide provider remains supported for comparisons. Adapters choose only among supplied operation/answer IDs; the extension alone executes actions.

Agents can manage Tabora's decision model directly through MCP without panel clicks. Discover the profile with `browser_profiles`, read `browser_provider_status`, and fetch `browser_provider_models` for the desired provider/connection. Configure an exact returned model ID with `browser_provider_configure`, then select that provider for the profile with `browser_provider_select`. For example:

```json
{"profileId":"<profile UUID>","provider":"codex-sdk","connection":"sdk"}
```

Pass that input to `browser_provider_models`, then pass the selected catalog ID to `browser_provider_configure`:

```json
{"profileId":"<profile UUID>","provider":"codex-sdk","model":"<returned model ID>","connection":"sdk","settingsScope":"host"}
```

Finally call `browser_provider_select` with `{"profileId":"<profile UUID>","provider":"codex-sdk"}`. Select `agent` instead to return decisions to the calling MCP agent. Model configuration is shared across **all profiles using this host**; the required `settingsScope: "host"` makes that effect explicit. Changing it cancels pending decisions and invalidates prepared actions in all connected profiles. Selecting the active provider affects only the selected profile. These are separate operations; if selection fails, a successfully saved host configuration remains saved. Reattach/observe before continuing after a change. Repeating an identical MCP configuration does not invalidate work.

Catalog checks do not prove entitlement or decision compatibility; the first decision verifies access. The tools use existing local SDK login, environment credentials or an already enabled/unlocked vault. They never accept secrets, unlock the vault, grant browser permissions, or change the model of the calling Codex/ChatGPT chat. The panel reflects MCP changes without saving a replacement model. After installing an updated build, reload an unpacked extension and reconnect/restart the MCP client to discover the new tools.

Decision runtimes are scoped to profile/session/provider and replaced when model, connection or credential configuration changes. At most 20 workers are retained, with a 60-second idle TTL. Calls within one scope are serialized by rejecting overlap; there is no hidden queue. Cancellation, errors and revocation tear down the runtime and reject stale replies. SDK login stays in the installed provider client. The Codex guard forwards its opaque bearer transiently to the validated official HTTPS endpoint; it does not copy auth files, persist credentials or change global Codex settings. The loopback guard has a random per-call path/token, rejects browser Origins and does not expose a general proxy.

Diagnostics separate worker setup/dispatch/failure cleanup, App Server startup/thread/turn/TTFT, input envelope sizes and action/wait/observe time. These spans are nested inside the end-to-end duration and must not be summed twice. Warm process reuse does not guarantee prompt-cache hits. No full prompts, pages or authentication headers are recorded by the transport diagnostics. See [implementation and inspiration](docs/decision-runtime.md). Installation tests do not establish performance superiority over Codex/ChatGPT's extension.

API references: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/quickstart), [Jev OpenAPI](https://api.typesafe.ai/openapi.json), [OpenAI model catalog](https://developers.openai.com/api/reference/typescript/resources/models/methods/list).

## Data, updates and removal

Default data directory: `%LOCALAPPDATA%\TaboraBrowser`. Installation resolves its physical Windows location and saves it in the generated `dist/native-host/state.json`; the native host, MCP server and managed browser all use that location. This also handles Microsoft Store/MSIX clients whose AppData writes are redirected into a package's `LocalCache`. Existing data stays in place. If the resolved location is inside a client package, uninstalling that client can remove it; use an explicit `TABORA_STATE_DIR` outside the package for storage independent of the client. Managed profiles live under `managed\<name>`; their `config.json` contains allowed origins and `browser.log` contains startup diagnostics. `TABORA_STATE_DIR` overrides the root; use the same absolute directory for browser and MCP. Setup carries an explicitly set override into MCP registration. The original Browser Pilot prototype has a separate host identity and data directory; nothing is imported automatically.

To update, stop managed profiles, `git pull --ff-only`, then rerun setup. Reload unpacked extensions in ordinary profiles. Do not move/delete the checkout while installed. Registrations are idempotent for the same checkout; a different checkout produces a conflict instead of replacing it.

To uninstall, stop each managed profile, remove Tabora from the browser's extensions, run `scripts/uninstall-host.ps1`, and remove the MCP entry from clients that registered it (`codex mcp remove tabora-browser` / `claude mcp remove tabora-browser --scope user`). Vault and browser data are retained. Remove them only if you explicitly want to discard those accounts and credentials.

## Development and validation

```powershell
npm ci
npm run check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-host.ps1
npx playwright install chromium
npm run test:native
npm run test:managed
npm run test:mcp
npm run test:mcp-legacy
npm run test:browser
npm run test:sdk
npm run test:capabilities
npm run test:widgets
npm run test:workflow
npm run test:files
npm run test:auth
npm run test:webmcp
```

Tests use synthetic pages and credentials; SDK smoke tests use synthetic API responses. No paid model calls or real vault are required. Windows CI validates the build, native messaging, managed setup, multiple profiles, vault scoping and MCP compatibility. Generated state and reports are ignored by Git. `extension-key.txt` is a public key committed to keep the extension ID stable; there is no signing private key in the repository.

`tests/webarena-run.mjs` is a separate opt-in paid integration pilot: `node tests/webarena-run.mjs --live --tasks <protocol.json> --output <directory>`. It requires a running localhost Shopping Admin fixture and existing SDK/Jev authentication. It isolates browser/host state and runs all scored operations through the extension and MCP. Never run it as an ordinary unit test; freeze answers before applying the pinned upstream evaluator. Three retrieval tasks are not a full WebArena score or a stability estimate.

Current scope and explicit limits are documented in [capabilities.md](docs/capabilities.md). This remains a Windows preview. CAPTCHA/MFA and OS dialogs use handoff; internal decisions are text-only. Native WebMCP is experimental and opt-in. Model benchmark success and performance superiority require independent paired measurements; executor integration tests alone do not establish them.

If the native host is unavailable, inspect the diagnostic code in the panel: `native_host_not_registered` means Chrome could not find the registration, `native_host_forbidden` indicates an origin or browser-policy restriction, `native_host_start_failed` means Chrome could not launch the process, `native_host_exited` means the process stopped, and `native_host_protocol_error` indicates invalid native messaging. Rerun setup from the original checkout when registration or launcher paths are incorrect, then inspect `npm run doctor`. After rebuilding, reload the unpacked extension on the browser's extensions page; the panel's refresh button only reconnects the currently loaded code. If no profiles appear, start the managed browser or enable MCP in the intended ordinary profile. A missing client CLI does not prevent generic stdio MCP use. For a stale managed-process lock, inspect the matching process and profile before removing `process.json`; never close all Chrome processes.

## License

[MIT](LICENSE).
