$ErrorActionPreference = 'Stop'
$taboraDirectory = [IO.Path]::GetFullPath($env:TABORA_PROCESS_DIRECTORY).TrimEnd('\') + '\'
$taboraInUse = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne [int]$env:TABORA_PROCESS_EXCLUDE -and (
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($taboraDirectory,[StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.IndexOf($taboraDirectory,[StringComparison]::OrdinalIgnoreCase) -ge 0)
  )
})
if ($taboraInUse.Count) { 'busy' } else { 'idle' }
