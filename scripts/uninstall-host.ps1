[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$pilotRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$pilotManifest = Join-Path $pilotRoot 'dist\native-host\com.tabora.browser.json'
foreach ($pilotBrowser in @('Google\Chrome','Microsoft\Edge','Chromium')) {
  $pilotRegistry = "HKCU:\Software\$pilotBrowser\NativeMessagingHosts\com.tabora.browser"
  if (Test-Path -LiteralPath $pilotRegistry) {
    if ((Get-Item -LiteralPath $pilotRegistry).GetValue('') -ne $pilotManifest) { throw 'Registration belongs to another checkout; refusing to remove it.' }
    Remove-Item -LiteralPath $pilotRegistry
  }
}
Write-Output 'Native host registration removed. Vault and source files were retained.'
