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
Write-Output "Unpacked extension directory: $(Join-Path $pilotRoot 'dist\extension')"
