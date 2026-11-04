$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot '..\physical-directory.ps1')
$taboraRequested = [IO.Path]::GetFullPath($env:TABORA_REQUESTED_INSTALL_ROOT).TrimEnd('\')
$taboraCandidates = @()
foreach ($taboraBrowser in @('Google\Chrome','Microsoft\Edge','Chromium')) {
  $taboraKey = "HKCU:\Software\$taboraBrowser\NativeMessagingHosts\com.tabora.browser"
  if (-not (Test-Path -LiteralPath $taboraKey)) { continue }
  $taboraManifest = (Get-Item -LiteralPath $taboraKey).GetValue('')
  if ([IO.Path]::GetFileName($taboraManifest) -ne 'native-host.json') { continue }
  $taboraDirectory = [IO.Path]::GetDirectoryName($taboraManifest)
  $taboraConfiguration = Join-Path $taboraDirectory 'installation.json'
  if (-not (Test-Path -LiteralPath $taboraConfiguration)) { continue }
  $taboraInstalled = Get-Content -LiteralPath $taboraConfiguration -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($taboraInstalled.schema -eq 1 -and $taboraInstalled.product -eq 'tabora-browser' -and $taboraInstalled.requestedInstallRoot -and [IO.Path]::GetFullPath($taboraInstalled.requestedInstallRoot).TrimEnd('\') -eq $taboraRequested) {
    $taboraCandidates += $taboraDirectory
  }
}
$taboraCandidates = @($taboraCandidates | Sort-Object -Unique)
if ($taboraCandidates.Count -gt 1) { throw 'installation_path_ambiguous' }
if ($taboraCandidates.Count -eq 1) { Resolve-TaboraPhysicalDirectory $taboraCandidates[0] }
else { Resolve-TaboraPhysicalDirectory $taboraRequested }
