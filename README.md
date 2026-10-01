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

Use `-Client claude`, `both`, or `none` to choose registration. `auto` skips missing CLIs; explicitly requesting a missing CLI fails with instructions. Model API keys are **not required** when the calling agent chooses actions through MCP. The optional nested model adapters have their own API credentials.

No website is permitted by default. Multiple origins can be passed as a PowerShell array when invoking `./scripts/setup.ps1` directly. Chrome host permissions cover all ports on the specified hostname; vault credential use additionally checks the exact HTTPS origin including port. The browser helper uses normal TLS verification.

## Managed profiles

```powershell
npm run browser -- start --profile work --allow-origin https://example.com
npm run browser -- status --profile work
npm run doctor -- --require-profile
npm run browser -- stop --profile work
```

Each name gets a separate persistent Chromium profile and extension identity within that profile. Repeating start returns the running instance. To add a permitted origin, stop the profile and start it again with `--allow-origin`; previous origins persist. First setup enables MCP; later starts preserve a user's disabled MCP setting. Use `--enable-mcp` explicitly on a stopped profile to enable it again. Site permissions can also be managed in the extension panel; to remove an origin pregranted by the launcher, stop the profile and remove it from its local `config.json`, then restart.

The browser runs as a background Node process until stopped or its window is closed. Control uses a local Windows named pipe, with no remote debugging TCP port. Stop targets only that managed profile. Do not use a managed profile directory with another browser process.

## Existing Chrome / Edge profile

Run setup without `-Managed`, then:

1. Open `chrome://extensions` or `edge://extensions` in the intended profile.
2. Enable Developer mode, choose **Load unpacked**, and select this checkout's `dist/extension`.
3. Open Tabora's side panel or extension options. Under **Profil a přístup přes MCP**, give the profile a name, enable MCP, and save.
4. Permit the required website in the panel. Run `npm run doctor -- --require-profile`.

Repeat the load/enable steps for other browser profiles. Their profile IDs are distinct. This project is not published to the Chrome Web Store; it does not silently install into ordinary Chrome profiles or bypass browser policy. [Chrome installation rules](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions) explain that boundary. The automatic route follows [Playwright's Chromium extension support](https://playwright.dev/docs/chrome-extensions).

## MCP clients and actions

The setup script uses the clients' supported registration commands. For other stdio clients, merge the generated, git-ignored `mcp.config.json` entry into their configuration. It points to the installed Node executable and `dist/host/mcp.js`; do not commit this machine-specific file. This is a local stdio server, not a hosted URL usable directly from a cloud ChatGPT connector.

References: [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude Code MCP](https://code.claude.com/docs/en/mcp).

The server exposes 13 tools. Typical flow:

1. `browser_profiles` → choose a profile ID; `browser_tabs` lists its tabs.
2. `browser_session_create` with a meaningful task name.
3. `browser_session_open` opens a link in that session's named tab group, or select an existing tab.
4. After navigation completes, `browser_session_attach` binds the exact tab/document.
5. `browser_observe` with recipe `click`, `fill`, `login`, or `extract`.
6. The agent chooses a target and calls `browser_prepare`. Alternatively `browser_decide` asks one of the configured decision adapters.
7. `browser_execute` with the returned single-use action ID; inspect the actual result before continuing.
8. `browser_session_release` releases ownership, leaving tabs open.

`browser_sessions`, `browser_cancel`, and `browser_vault_list` support inspection, cancellation and credential metadata. Each MCP connection owns its sessions; one session owns an attached tab. Different sessions/profiles can work concurrently. Navigation invalidates prepared actions; reattach and observe. Click dispatch is not proof that the website completed the intended operation. Do not automatically retry ambiguous actions.

## Optional vault and decision providers

Vault setup and unlock happen in the extension panel. Credentials can be shared across profiles or restricted to one profile (the default). Each profile has its own unlock grant and timeout. Website login uses a credential ID and fills only the bound exact HTTPS origin. Passwords and provider keys are not returned through MCP or sent to decision models.

The vault uses AES-256-GCM with a Windows DPAPI-protected key. It is local to the Windows user, with no biometric challenge, cloud sync or cross-machine recovery. Profile scoping is enforced by the application; it is **not** a security boundary against arbitrary processes running as the same Windows user. Deleting the encryption key can make saved credentials unrecoverable.

| Decision adapter | Status in this repository |
| --- | --- |
| Codex SDK | API-key adapter with isolated runtime and guarded decision-only transport |
| Claude Agent SDK | API-key adapter; external tools and inherited MCP disabled |
| TypeSafe / Jev | System One choice adapter |
| OpenAI Decisions API | Explicit unavailable placeholder pending a verified API contract; no substitute model |

Choose a model supported by your account and enter its provider key in the vault. Adapters select among observed choices; only the local executor performs actions. Browser control via an already authenticated Codex/Claude MCP client avoids this extra model call. Inherited local SDK login experiments and historical Snake benchmarks are not part of this clean release. No claim of superiority over Codex/ChatGPT's extension is made by these installation tests.

## Data, updates and removal

Default data directory: `%LOCALAPPDATA%\TaboraBrowser`. Managed profiles live under `managed\<name>`; their `config.json` contains allowed origins and `browser.log` contains startup diagnostics. `TABORA_STATE_DIR` overrides the root; use the same absolute directory for browser and MCP. Setup carries an explicitly set override into MCP registration. The original Browser Pilot prototype has a separate host identity and data directory; nothing is imported automatically.

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

Current scope: main-document DOM controls and bounded tables/forms. Iframes, shadow DOM, canvas, CAPTCHA/MFA automation and trusted OS input are unsupported. macOS/Linux native installation and secure key storage are not implemented. This is an early preview, not an audited password manager.

If the native host is unavailable, rerun setup from the original checkout and inspect `npm run doctor`. If no profiles appear, start the managed browser or enable MCP in the intended ordinary profile. A missing client CLI does not prevent generic stdio MCP use. For a stale managed-process lock, inspect the matching process and profile before removing `process.json`; never close all Chrome processes.

## License

[MIT](LICENSE).
