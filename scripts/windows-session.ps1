$ErrorActionPreference = 'Stop'
try {
  $taboraWhoami = Join-Path $env:SystemRoot 'System32\whoami.exe'
  $taboraLogon = (& $taboraWhoami /logonid | Out-String)
  if ($LASTEXITCODE -ne 0 -or $taboraLogon -notmatch 'S-1-5-5-\d+-\d+') { throw 'Logon identity unavailable' }
  $taboraSid = $Matches[0]
  $taboraBoot = (Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime).LastBootUpTime
  if ($null -eq $taboraBoot) { throw 'Boot identity unavailable' }
  [Console]::Out.Write((@{logonId=$taboraSid;bootId=$taboraBoot.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)} | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.Write('Windows session identity unavailable.')
  exit 1
}
