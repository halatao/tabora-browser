# Standalone installation and release operations

Tabora 0.6.0 adds a Windows x64 package with its own Node runtime, stable native/MCP launcher, verified update staging, version activation, recovery and extension lifecycle coordination. Source checkout installation remains supported.

**Distribution status:** Windows preview. `release-trust.json` contains the public Ed25519 release root; its private key is held in the GitHub `release` environment, outside the repository. Preview releases distribute signed ZIP manifests. Stable releases additionally require an Authenticode-signed EXE installer. Chrome Web Store publishing is a separate publisher gate.

See the [Windows validation report](distribution-validation-2026-11-04.md) for the tested build, exact artifacts and remaining release gates.

Stable is the default update channel. `tabora.exe install --channel preview` explicitly opts into signed preview releases as well as newer stable releases. Switching back selects stable-only updates and never downgrades the installed version. Channel-specific advisory caches stay separate.

## Install a prepared ZIP

Extract the complete Windows x64 ZIP into a temporary folder, then run:

```powershell
.\tabora.exe install --auto-update
```

Git, npm and a system Node installation are not needed. `--auto-update` opts into verified stable updates between tasks; omitting it selects notifications only. Effective remote availability also requires a configured public release key. SDK authentication is separate; MCP browser control needs no paid model call.

Advanced installation flags keep everyday UI unchanged: `--notify-only` permits checks without automatic installation, and `--no-updates` disables new remote checks/prepares and remote apply for the shared host. Explicit offline installer upgrades remain possible. Re-running the installed `install` command with one of these flags changes that policy without resetting profile settings.

After a matching Store item exists, a fresh host installation can use `--extension-channel store`; the updater then leaves extension code to Chrome. The default remains unpacked. Changing an existing installation between these distributions is refused with a migration requirement; it never silently changes extension identity or discards storage.

For ordinary Chrome/Edge, enable Developer mode and use Load unpacked once with the printed `extension-unpacked` directory in the intended profile. Chrome controls installation and new-permission consent. Reconnect the MCP client, then verify the actual browser connection:

```powershell
& "$env:LOCALAPPDATA\Programs\TaboraBrowser\tabora.exe" doctor --require-profile
```

The EXE installer uses the same payload and per-user registration. Its definition is `installer/tabora.iss`; compiling it requires Inno Setup and stable publication requires an Authenticode certificate. ZIP-only preview publication skips the compiler entirely and signs its exact release manifest using Ed25519. No self-signed Windows certificate is substituted for a publisher certificate.

Managed Chromium is an optional download:

```powershell
& "$env:LOCALAPPDATA\Programs\TaboraBrowser\tabora.exe" browser install
& "$env:LOCALAPPDATA\Programs\TaboraBrowser\tabora.exe" browser start --profile work --headless
```

The packaged Playwright runtime selects its matching browser revision. Updating a running managed profile restarts only that owned instance and preserves its origins, profile UUID, MCP revocation and vault setting. Its helper must confirm the expected profile identity before it can be stopped. Ordinary Chrome windows and private tabs are not restarted or activated.

## Migrate an existing source installation

Finish active work and inspect any uncertain writes. From the extracted new package:

```powershell
.\tabora.exe install --migrate-from 'C:\permanent\tabora-browser'
```

Migration reads the source installation's physical state-directory binding. It preserves the checkout and its local changes; it does not run Git reset/pull, move browser profiles, import cookies or unlock the vault. Native registration replacement is allowed only for that exact source checkout. Codex migration preserves the reviewed Tabora environment/file-root configuration and restores the old MCP entry if replacement fails.

Other registrations are conflicts, not overwrite candidates. Existing Claude entries require exact identity/scope recognition for repair/removal; automatic source-to-Claude migration remains a manual configuration-review step. A missing client CLI is skipped, so the host can be installed before the agent client.

For a client without a usable registration CLI, `tabora.exe mcp-config` prints a minimal configuration for the stable launcher. Merge that single server through the client's supported settings; do not overwrite unrelated configuration or add broad file roots.

Point Chrome's unpacked installation at the new stable directory without deleting the existing extension's storage. Verify that its extension ID and profile UUID are unchanged before resuming. A Store item with a different ID requires a separately verified migration; this implementation refuses that identity change. Store publishing has not been configured.

Older extensions, native bridges and shared brokers need one bootstrap update/reconnect before they support the new maintenance protocol. The updater reports `extension_update_required`, `native_host_restart_required` or `broker_update_required`; it does not force a partial live upgrade. Keep existing ordinary tabs open.

## Installed layout

```text
%LOCALAPPDATA%/Programs/TaboraBrowser/
  tabora.exe
  installation.json
  native-host.json
  versions/<version>-<build-prefix>/
  extension-unpacked/
```

The existing physical state directory stays separate, including explicit state overrides and MSIX alias resolution. A new installation refuses to put its data inside its program directory. Broker routing and the DPAPI-protected routing token remain local; there is no new HTTP update server.

Each version contains its own runtime, production dependencies, SDK packages, OCR data, PDF/native modules, scripts, licenses and file inventory. Program rollback changes the active version pointer and unpacked files, not an old copy of the vault. The same Windows user and existing vault/profile scopes continue to apply.

## Agent update flow

1. `browser_update_check` returns the advisory version result, installation kind, policy and whether trusted remote packages are available. A source checkout never silently updates itself.
2. `browser_update_prepare` verifies signed stable metadata, downloads the exact payload and checks its archive and file inventory. It returns an update ID and maintenance ticket while the download continues.
3. Poll `browser_update_status` until `staged`. Apply with that exact ID and ticket through `browser_update_apply`.
4. The separate updater waits for active requests/runs, seals extension admission, activates the version and coordinates reconnect. Its journal survives the requesting MCP process.
5. Read status after reconnect. `scheduled` is not completion. An old MCP process reports `mcp_restart_required`; a current one still requires an actually connected, compatible extension before reporting `completed`.

`profile_connection_required` means host/files are installed but browser verification is pending. Chrome may be closed or require consent; the updater does not invent a specific cause from a missing connection. `recovery_required` means repair is necessary. Opaque tickets are not arbitrary shell commands, file paths or remote URLs.

All update tools require the existing authenticated local MCP connection. Page/model content cannot select an executable URL. A maintenance ticket binds apply to a prepared job for the same installation. Profile disablement, ordinary task ownership and exact document/origin checks continue to apply to browser actions.

Pending plans are invalidated across reload. Unknown write outcomes are recorded as bounded session metadata in extension storage and the update journal; no action or run is automatically replayed. An agent must inspect the business result before repeating such a write.

CLI equivalents:

```powershell
tabora.exe update check
tabora.exe update prepare
tabora.exe update status UPDATE_ID
tabora.exe update apply UPDATE_ID TICKET_FROM_PREPARE
```

Installing a newer prepared ZIP/EXE over an owned package schedules the same updater through a local-installer job. It does not treat unsigned remote metadata as authorization. Reinstalling the exact same payload repairs owned registrations and can restore damaged program files while the installation is idle. Unknown extension permissions are a review requirement, not a reason to restore broader defaults.

## Recovery and removal

Run `tabora.exe repair` for owned registration repair and interrupted-update recovery. Recovery checks that the recorded updater PID is no longer running; it never kills other Node/Chrome processes or deletes an ambiguous lock. It drains the broker before restoring program files, then verifies the host again. If the active runtime itself is missing, run the fresh extracted package's `install --root ORIGINAL_INSTALL_DIRECTORY` instead.

Current and previous program versions are retained. Older versions with live processes are deferred; cleanup does not delete files underneath a running older MCP process. Terminal jobs retain their journals while large staged payloads are removed. Program cleanup validates ownership, absolute containment and reparse-free trees before recursive removal.

`tabora.exe uninstall` unregisters only entries that still belong to this installation and retains user data. For ZIP installations, delete the verified program folder after its processes have stopped. The EXE uninstaller validates its owned layout before removing program files; it leaves the separate data directory intact. Foreign registrations are not removed.

## Publisher setup

The release workflow runs on a version tag or manual dispatch. Stable tags are `v<package.json version>`; preview tags are `preview-v<package.json version>` and become GitHub prereleases, never the stable latest release. Chrome requires numeric versions, so each published preview and its later stable successor use increasing numeric package versions; do not republish the same numeric version to promote it. Manual dispatch can build either channel without publishing. Tagged publication requires:

| Configuration | Where | Purpose |
| --- | --- | --- |
| `TABORA_RELEASE_TRUST` | Protected `release` environment variable | JSON `{ "schema": 1, "keys": [{ "publicKey": "PEM PUBLIC KEY" }] }`; public Ed25519 roots embedded in the payload |
| `TABORA_RELEASE_PRIVATE_KEY` | Protected environment secret | Corresponding Ed25519 signing key; never committed or included in the payload |
| `TABORA_AUTHENTICODE_PFX` | Protected environment secret | Required for stable: base64 publisher certificate/private-key bundle for the Windows installer |
| `TABORA_AUTHENTICODE_PASSWORD` | Protected environment secret | Required for stable: certificate password |

The workflow supplies a monotonic run sequence. Metadata has a 90-day validity period, OS/architecture, protocol and minimum-updater constraints. Plan renewed signed releases before expiry; an expired check does not stop an already installed Tabora. Root rotation ships a nonempty trusted replacement set inside a payload verified by the previous root. Do not remove the transition root before installed clients can reach the new one.

Artifacts: standalone ZIP, extension ZIP, SBOM inventory, checksums, exact-byte `release-manifest.json` and detached Ed25519 signature. Stable also includes the signed installer; ZIP-only previews omit it. Initial trust comes from the distribution chosen by the user; checksums alone are not publisher authentication. Release data from `main/package.json` remains advisory only.

The publisher requires passing browser CI for the exact release tag, then uploads a draft, downloads every asset back and compares bytes before publishing the complete set. Failed uploads remain drafts. Store distribution is a separate publisher operation: Chrome updates Store-managed extension code; the host updater never rewrites a Store directory. Supported protocol compatibility, rather than an exact fingerprint, permits asynchronous Store/host rollout.

## Build and verify

```powershell
npm ci
npm run check
npm run package
npm run test:package -- release/payload
npm run test:package-update -- release/payload
```

`test:package` extracts the actual ZIP, installs into an isolated Unicode path, removes system Node/Git from the child's PATH, exercises real interactive MCP and binary native messaging, imports packaged SDK/OCR/PDF/native dependencies and rejects inventory tampering. It does not change the user's native registry or MCP configuration. This is PATH isolation on the test Windows host, not proof of every clean Windows image.

`test:package-update` uses an isolated synthetic next-release identity to exercise real staging, pointer/file activation, broker generation change and post-update host verification. It does not call a paid model or publish a release. Browser verification stays explicitly pending when no profile is connected.

After source native-host registration and `playwright install chromium`, run `npm run test:update-browser`. It enables Developer mode through the isolated profile's extensions UI, exercises maintenance and native-triggered reload, preserves UUID/vault-off, and proves a pending click is not replayed. Chrome disables a command-line-loaded extension on reload when Developer mode is off (`unsupportedDeveloperExtension`); the test does not edit profile preference files or bypass policy. Managed updates use their owned process restart instead.

Public Store identity migration, code-signing credentials, actual Store acceptance and a complete clean-Windows installer/release rollout remain publisher validation gates. Do not describe the local preview as a published or fully field-validated distribution.
