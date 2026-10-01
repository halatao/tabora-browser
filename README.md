# Tabora Browser

Local browser control for AI agents, through MCP. A Manifest V3 extension executes bounded DOM actions; a small local host routes profiles and optionally stores encrypted credentials. MIT licensed. Windows preview; Chrome, Edge and bundled Chromium. The extension UI is currently in Czech; MCP tool descriptions are in English.

## Quick start

Prerequisites: Windows 10/11, Git and Node.js 22 or newer. Install in a permanent, user-owned directory; MCP and native messaging use its absolute path. No administrator rights are needed.

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

The extension requests access to HTTP(S) sites once during installation, so there is no per-site setup in the panel. Browser consent and enterprise policies still apply. Managed profiles inherit this default; passing `-AllowOrigin` restricts that managed copy to the listed sites. Multiple origins can be passed as a PowerShell array when invoking `./scripts/setup.ps1` directly. Chrome host permissions cover all ports on the specified hostname; vault credential use additionally checks the exact HTTPS origin including port. The browser helper uses normal TLS verification.

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
3. Open Tabora’s side panel or extension options. Connection starts automatically; new profiles enable MCP, use Safe mode, and keep the vault off.
4. Run `npm run doctor -- --require-profile`.

Repeat the load steps for other browser profiles. The name is read from Chrome/Edge profile metadata when exactly one matching installed profile can be identified. Chrome does not expose the display name directly to extensions. If multiple profiles match, choose the profile once in Settings; Tabora does not guess from “last used”. Managed profiles use their launcher name. Existing explicit MCP revocation is preserved. Their profile IDs are distinct. This project is not published to the Chrome Web Store; it does not silently install into ordinary Chrome profiles or bypass browser policy. [Chrome installation rules](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions) explain that boundary. The automatic route follows [Playwright's Chromium extension support](https://playwright.dev/docs/chrome-extensions).

## Three browser modes

The main panel contains the mode, provider, model select and vault switch. Manual controls and diagnostics are collapsed; settings are secondary.

| Mode | Behavior |
| --- | --- |
| Safe (default) | First open creates a new normal window and named group for that session. Later opens reuse that window/group. Existing tabs, other sessions’ tabs, and tabs moved out of the group cannot be controlled. |
| Risk / Takeover | The agent can attach existing HTTP(S) tabs. Session ownership still prevents two clients controlling the same tab. |
| Read only | Existing tabs can be attached and visible page text/tables extracted; click, fill and login recipes are rejected. |

Safe shares the current profile’s cookies and website login; it is not incognito or a separate account sandbox. Read only prevents Tabora actions from changing page content, not the site’s own JavaScript/network activity. Changing modes invalidates prepared actions and document bindings. Disabling the vault revokes credential access and locks this profile’s grant without deleting saved secrets. The main Stop button cancels all sessions in this profile.

The vault switch is off for new installations and migration from profiles without the switch. Enabling it reveals vault management; unlocking is a separate explicit action. MCP and site consent are independent of vault access.

## MCP clients and actions

The setup script uses the clients' supported registration commands. For other stdio clients, merge the generated, git-ignored `mcp.config.json` entry into their configuration. It points to the installed Node executable and `dist/host/mcp.js`; do not commit this machine-specific file. This is a local stdio server, not a hosted URL usable directly from a cloud ChatGPT connector.

References: [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude Code MCP](https://code.claude.com/docs/en/mcp).

The server exposes 13 tools. Typical flow:

1. `browser_profiles` → choose a profile ID; `browser_tabs` lists its tabs.
2. `browser_session_create` with a meaningful task name.
3. `browser_session_open` opens a link in that session’s named tab group (and new window in Safe), or select an existing tab in Takeover/Read only.
4. After navigation completes, `browser_session_attach` binds the exact tab/document.
5. `browser_observe` with recipe `click`, `fill`, `login`, or `extract`. Read only permits `extract` only; login requires the enabled/unlocked vault.
6. The agent chooses a target and calls `browser_prepare`. Alternatively `browser_decide` asks one of the configured decision adapters.
7. `browser_execute` with the returned single-use action ID; inspect the actual result before continuing.
8. `browser_session_release` releases ownership, leaving tabs open.

`browser_sessions`, `browser_cancel`, and `browser_vault_list` support inspection, cancellation and credential metadata. Each MCP connection owns its sessions; one session owns an attached tab. Different sessions/profiles can work concurrently. Navigation invalidates prepared actions; reattach and observe. Click dispatch is not proof that the website completed the intended operation. Do not automatically retry ambiguous actions.

## Optional vault and decision providers

Vault is off by default. Setup and explicit unlock happen in the extension panel. Credentials can be shared across profiles or restricted to one profile (the default). Each profile has its own unlock grant and timeout. Website login uses a credential ID and fills only the bound exact HTTPS origin. Passwords and provider keys are not returned through MCP or sent to decision models.

The vault uses AES-256-GCM with a Windows DPAPI-protected key. It is local to the Windows user, with no biometric challenge, cloud sync or cross-machine recovery. Profile scoping is enforced by the application; it is **not** a security boundary against arbitrary processes running as the same Windows user. Deleting the encryption key can make saved credentials unrecoverable.

| Decision adapter | Status in this repository |
| --- | --- |
| Codex SDK | Local authenticated Codex App Server runtime from the SDK package; ephemeral threads, tools/inherited MCP/plugins disabled. Optional API-key route uses guarded Responses transport. |
| Claude Agent SDK | Existing local SDK login or optional API key; external tools and inherited MCP disabled. |
| TypeSafe / Jev | System One choice adapter; system environment key or optional vault key. |
| OpenAI Decisions API | Explicit unavailable placeholder pending a verified API contract; no substitute model |

Select a provider, connect its SDK/catalog, then select a model. No free-text model field is used. Codex model choices come from App Server model/list; Claude from supportedModels(); Jev from its authenticated /v1/models. Optional Codex API-key mode lists text-model families from the OpenAI API catalog. A catalog is not proof of entitlement or structured-output compatibility; the first decision validates actual access. Catalogs are cached for five minutes and the Connect button refreshes them. SDK authentication remains with the local provider client; Tabora neither imports credentials into the vault nor unlocks it automatically. If the SDK reports login_required, sign in through that provider’s local client and reconnect.

The default **Connected agent / MCP** provider lets the calling agent choose via browser_prepare, avoiding an extra model call. browser_profiles returns activeProvider as the profile’s preference; an explicitly supplied browser_decide provider remains supported for comparisons. Adapters only choose among observed targets; the extension alone executes actions. No performance superiority over Codex/ChatGPT’s extension is claimed by these installation tests.

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
```

Tests use synthetic pages and credentials; SDK smoke tests use synthetic API responses. No paid model calls or real vault are required. Windows CI validates the build, native messaging, managed setup, multiple profiles, vault scoping and MCP compatibility. Generated state and reports are ignored by Git. `extension-key.txt` is a public key committed to keep the extension ID stable; there is no signing private key in the repository.

Current scope: main-document DOM controls, visible text (16,000 characters) and bounded tables/forms. Iframes, shadow DOM, canvas, CAPTCHA/MFA automation and trusted OS input are unsupported. macOS/Linux native installation and secure key storage are not implemented. This is an early preview, not an audited password manager.

If the native host is unavailable, inspect the diagnostic code in the panel: `native_host_not_registered` means Chrome could not find the registration, `native_host_forbidden` indicates an origin or browser-policy restriction, `native_host_start_failed` means Chrome could not launch the process, `native_host_exited` means the process stopped, and `native_host_protocol_error` indicates invalid native messaging. Rerun setup from the original checkout when registration or launcher paths are incorrect, then inspect `npm run doctor`. After rebuilding, reload the unpacked extension on the browser's extensions page; the panel's refresh button only reconnects the currently loaded code. If no profiles appear, start the managed browser or enable MCP in the intended ordinary profile. A missing client CLI does not prevent generic stdio MCP use. For a stale managed-process lock, inspect the matching process and profile before removing `process.json`; never close all Chrome processes.

## License

[MIT](LICENSE).
