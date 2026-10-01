param([Parameter(Mandatory=$true)][string]$ProfilePath)
$ErrorActionPreference = 'Stop'
$taboraState = if ($env:TABORA_STATE_DIR) { $env:TABORA_STATE_DIR } else { Join-Path $env:LOCALAPPDATA 'TaboraBrowser' }
$taboraManaged = [IO.Path]::GetFullPath((Join-Path $taboraState 'managed')) + [IO.Path]::DirectorySeparatorChar
$taboraProfile = [IO.Path]::GetFullPath($ProfilePath)
if (-not $taboraProfile.StartsWith($taboraManaged, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $taboraProfile) -ne 'chromium') { throw 'Not a managed Tabora profile.' }
$taboraPattern = '--user-data-dir="?' + [Regex]::Escape($taboraProfile) + '(?=["\s]|$)'
$taboraProcesses = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match $taboraPattern -and $_.CommandLine -notmatch '--type=' }
foreach ($taboraProcess in $taboraProcesses) {
  & taskkill.exe /PID $taboraProcess.ProcessId /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not close the managed Chromium process.' }
}
