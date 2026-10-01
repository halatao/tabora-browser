[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$pilotRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$pilotNode = (Get-Command node -ErrorAction Stop).Source
$pilotMain = Join-Path $pilotRoot 'dist\host\main.js'
if (($pilotRoot + $pilotNode) -match '[%\r\n]') { throw 'Install from a path without percent signs or newlines (native host .cmd limitation).' }
if (-not (Test-Path -LiteralPath $pilotMain)) { throw 'Run npm run build first.' }
$pilotId = (Get-Content -LiteralPath (Join-Path $pilotRoot 'extension-id.txt') -Raw).Trim()
if ($pilotId -notmatch '^[a-p]{32}$') { throw 'Invalid extension ID.' }
$pilotNativeDir = Join-Path $pilotRoot 'dist\native-host'
New-Item -ItemType Directory -Path $pilotNativeDir -Force | Out-Null
$pilotLauncher = Join-Path $pilotNativeDir 'host.cmd'
$pilotManifest = Join-Path $pilotNativeDir 'com.tabora.browser.json'
foreach ($pilotBrowser in @('Google\Chrome','Microsoft\Edge','Chromium')) {
  $pilotRegistry = "HKCU:\Software\$pilotBrowser\NativeMessagingHosts\com.tabora.browser"
  if (Test-Path -LiteralPath $pilotRegistry) {
    $pilotExisting = (Get-Item -LiteralPath $pilotRegistry).GetValue('')
    if ($pilotExisting -ne $pilotManifest) { throw 'Tabora native host is registered from another checkout. Uninstall that registration before switching checkouts.' }
  }
}
$pilotStateFile = Join-Path $pilotNativeDir 'state.json'
$pilotRequestedState = $null
if ($env:TABORA_STATE_DIR) {
  if (-not [IO.Path]::IsPathRooted($env:TABORA_STATE_DIR)) { throw 'TABORA_STATE_DIR must be absolute.' }
  $pilotState = $env:TABORA_STATE_DIR
} elseif (Test-Path -LiteralPath $pilotStateFile) {
  $pilotStateConfig = Get-Content -LiteralPath $pilotStateFile -Raw | ConvertFrom-Json
  if ($pilotStateConfig.version -ne 1 -or -not $pilotStateConfig.stateDir -or -not [IO.Path]::IsPathRooted($pilotStateConfig.stateDir)) { throw 'Invalid installed state directory.' }
  $pilotState = $pilotStateConfig.stateDir
  if ($pilotStateConfig.requestedStateDir) {
    if (-not [IO.Path]::IsPathRooted($pilotStateConfig.requestedStateDir)) { throw 'Invalid installed state directory alias.' }
    $pilotRequestedState = $pilotStateConfig.requestedStateDir
  }
} else {
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is missing.' }
  $pilotState = Join-Path $env:LOCALAPPDATA 'TaboraBrowser'
}
New-Item -ItemType Directory -Path $pilotState -Force | Out-Null
. (Join-Path $PSScriptRoot 'physical-directory.ps1')
$pilotPhysicalState = Resolve-TaboraPhysicalDirectory $pilotState
if (-not $pilotRequestedState) { $pilotRequestedState = [IO.Path]::GetFullPath($pilotState) }
[IO.File]::WriteAllText($pilotStateFile, (@{version=1;stateDir=$pilotPhysicalState;requestedStateDir=$pilotRequestedState} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$pilotCommand = '@echo off' + "`r`n" + 'setlocal DisableDelayedExpansion' + "`r`n" + 'chcp 65001 >nul' + "`r`n" + '"' + $pilotNode + '" "' + $pilotMain + '" %*' + "`r`n"
[IO.File]::WriteAllText($pilotLauncher, $pilotCommand, [Text.UTF8Encoding]::new($false))
$pilotDefinition = @{
  name = 'com.tabora.browser'; description = 'Tabora Browser local decision host';
  path = $pilotLauncher; type = 'stdio'; allowed_origins = @("chrome-extension://$pilotId/")
} | ConvertTo-Json
[IO.File]::WriteAllText($pilotManifest, $pilotDefinition, [Text.UTF8Encoding]::new($false))
foreach ($pilotBrowser in @('Google\Chrome','Microsoft\Edge','Chromium')) {
  $pilotRegistry = "HKCU:\Software\$pilotBrowser\NativeMessagingHosts\com.tabora.browser"
  New-Item -Path $pilotRegistry -Force | Out-Null
  Set-Item -LiteralPath $pilotRegistry -Value $pilotManifest
}
Write-Output "Native host registered for the current Windows user. Extension ID: $pilotId"
Write-Output "Shared physical state directory: $pilotPhysicalState"
Write-Output "Unpacked extension directory: $(Join-Path $pilotRoot 'dist\extension')"
