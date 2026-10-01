param([Parameter(Mandatory=$true)][string]$ProfilePath)
$ErrorActionPreference = 'Stop'
$pilotTestRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.test-state')) + [IO.Path]::DirectorySeparatorChar
$pilotProfilePath = [IO.Path]::GetFullPath($ProfilePath)
if (-not $pilotProfilePath.StartsWith($pilotTestRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Not a test profile.' }
$pilotPattern = '--user-data-dir="?' + [Regex]::Escape($pilotProfilePath) + '(?=["\s]|$)'
$pilotProcesses = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match $pilotPattern -and $_.CommandLine -notmatch '--type=' }
foreach ($pilotProcess in $pilotProcesses) {
  & taskkill.exe /PID $pilotProcess.ProcessId /T /F | Out-Null
}
