# Checking and updating Tabora

For the 0.6.0 standalone package, verified prepare/apply/status tools, recovery and publisher setup, see [distribution and release operations](distribution.md). The [implementation plan](distribution-and-auto-update-plan-2026-11-03.md) records the design and remaining publisher gates. The manual checkout instructions below still apply to source installations.

Tabora checks version metadata from the official repository in the native host. The MCP server starts a check without delaying browser actions. When a newer version is found, a subsequent tool response contains a separate `taboraNotice: update_available` text block asking the calling agent to tell the user in the current chat and offer the installed channel's update steps. Ordinary result JSON remains the first text block.

The notice is emitted once per version per MCP connection. It can arrive only while the agent is using Tabora; it cannot send a message to a dormant chat. A host/extension build mismatch found by `browser_capabilities` also produces an explicit notice. This does not change the chat's model.

The MCP server also compares its own build to the running host. If an older broker does not yet support the update tool, it reports `broker_update_required` with locally bundled restart instructions instead of presenting an unknown-tool error as an update result.

## Manual check through MCP

```json
{"tool":"browser_update_check","arguments":{"refresh":true}}
```

The result distinguishes `update_available`, `up_to_date`, `unavailable`, `not_checked` and `disabled`. It includes installed build identity, latest version, source, check time and update instructions. A failed request is never evidence that the installation is current.

The checker first requests the latest non-prerelease GitHub release. If the repository has no releases, it checks `main/package.json` and reports `source: main`; that source is development metadata rather than a published release. Stable numeric version comparison avoids reporting a downgrade. Changes published under the same version number are not detected remotely; publish a new version for each update. Local `sameBuild` diagnostics still detect different host/extension fingerprints.

Successful advisory metadata is cached in the configured local state directory for six hours; failed attempts are throttled for 30 minutes. Concurrent checks share one request. These requests have a four-second timeout and bounded responses. The advisory cache contains only release version/tag, channel-specific source and timestamp. This checker does not execute release prose or install assets. The standalone installer/updater separately verifies signed metadata and payloads. Set `TABORA_UPDATE_CHECK=0` in an MCP process's environment to suppress its remote checks and prepare, even when it connects to an already running broker. Use the installed `--no-updates` policy for shared-host disablement; one client's environment does not revoke another client's host-wide update opt-in.

## Updating an existing installation

1. Finish or cancel current tasks. If a write has an unknown outcome, inspect its business result before repeating anything. Stop managed profiles before updating their files.
2. Open the original installed checkout and inspect `git status`. Preserve local changes; do not reset or overwrite them. Then run `git pull --ff-only`.
3. Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1 -Client auto` from that checkout. This rebuilds and registers the host and available MCP clients. Retain the existing profile, origin and file-root configuration. Do not create a replacement profile just to update.
4. In ordinary Chrome/Edge profiles, reload Tabora at `chrome://extensions` / `edge://extensions` and complete browser consent if requested. Restart managed profiles using their existing configuration. An unpacked extension is not silently replaced through Chrome Web Store update APIs.
5. Reconnect the MCP client. Select the intended profile, create a new owned session and call `browser_capabilities`; verify `compatible: true` and `sameBuild: true` before continuing.

If `sameBuild` stays false, an older shared broker can still be serving another connected profile. Finish all Tabora tasks, temporarily disable Tabora in every connected browser profile and stop its MCP clients. Let the idle broker exit, then re-enable/reload Tabora and reconnect. Ordinary browser tabs can stay open. Do not kill unrelated Chrome or Node processes to force an update.

For an installation without Git, obtain the published version and follow its README. Keep the installed checkout at its original path. The checker itself performs no installation, browser reload, task cancellation or credential access.
