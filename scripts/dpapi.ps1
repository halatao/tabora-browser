param([ValidateSet('protect','unprotect')][string]$Operation)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $pilotBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  $pilotScope = [Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($Operation -eq 'protect') {
    $pilotResult = [Security.Cryptography.ProtectedData]::Protect($pilotBytes, $null, $pilotScope)
  } else {
    $pilotResult = [Security.Cryptography.ProtectedData]::Unprotect($pilotBytes, $null, $pilotScope)
  }
  [Console]::Out.Write([Convert]::ToBase64String($pilotResult))
  [Array]::Clear($pilotBytes, 0, $pilotBytes.Length)
  [Array]::Clear($pilotResult, 0, $pilotResult.Length)
} catch {
  [Console]::Error.Write('OS key protection failed.')
  exit 1
}
