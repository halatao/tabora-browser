[CmdletBinding()]
param(
  [ValidateSet('auto','codex','claude','both','none')][string]$Client = 'auto',
  [switch]$Managed,
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,47}$')][string]$Profile = 'default',
  [string[]]$AllowOrigin = @(),
  [string[]]$FileRoot = @(),
  [switch]$Headless
)
$ErrorActionPreference = 'Stop'
$taboraRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ($env:OS -ne 'Windows_NT') { throw 'This release supports Windows only.' }
$taboraNode = (Get-Command node -ErrorAction Stop).Source
$taboraMajor = & $taboraNode -p 'parseInt(process.versions.node)'
if ($LASTEXITCODE -ne 0 -or [int]$taboraMajor -lt 22) { throw 'Install Node.js 22 or newer, then retry.' }
$taboraNpm = (Get-Command npm.cmd -ErrorAction Stop).Source
$taboraOldFileRoots = $env:TABORA_FILE_ROOTS
if ($FileRoot.Count) {
  $taboraFileRoots = @($FileRoot | ForEach-Object { $taboraResolved = Resolve-Path -LiteralPath $_ -ErrorAction Stop; if (-not (Test-Path -LiteralPath $taboraResolved.Path -PathType Container)) { throw 'FileRoot must be an existing directory.' }; $taboraResolved.Path })
  $env:TABORA_FILE_ROOTS = ConvertTo-Json -InputObject $taboraFileRoots -Compress
}
$taboraEncodedFileRoots = if ($env:TABORA_FILE_ROOTS) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($env:TABORA_FILE_ROOTS)) } else { $null }
Push-Location -LiteralPath $taboraRoot
try {
  & $taboraNpm ci --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
  & $taboraNpm run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
  & (Join-Path $PSScriptRoot 'install-host.ps1')
  $taboraMain = Join-Path $taboraRoot 'dist\host\mcp.js'
  foreach ($taboraClient in @('codex','claude')) {
    if ($Client -eq 'none' -or ($Client -notin @('auto','both') -and $Client -ne $taboraClient)) { continue }
    $taboraCli = Get-Command $taboraClient -ErrorAction SilentlyContinue
    if (-not $taboraCli) {
      if ($Client -ne 'auto') { throw "$taboraClient CLI is not on PATH. Install it or use -Client none and mcp.config.json." }
      Write-Output "$taboraClient CLI not found; skipping registration."
      continue
    }
    # Never print existing config: it may contain unrelated credentials.
    $taboraGet = @('mcp','get','tabora-browser')
    if ($taboraClient -eq 'codex') { $taboraGet += '--json' }
    $ErrorActionPreference = 'Continue'
    try { $taboraExisting = & $taboraCli.Source @taboraGet 2>$null; $taboraGetExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = 'Stop' }
    if ($taboraGetExit -eq 0) {
      $taboraText = $taboraExisting -join "`n"
      if ($taboraClient -eq 'codex') {
        $taboraConfig = $taboraText | ConvertFrom-Json
        $taboraTransport = $taboraConfig.transport
        $taboraSame = $taboraTransport.command -eq $taboraNode -and @($taboraTransport.args).Count -eq 1 -and $taboraTransport.args[0] -eq $taboraMain -and $taboraTransport.env.TABORA_STATE_DIR -eq $env:TABORA_STATE_DIR -and (-not $taboraEncodedFileRoots -or $taboraTransport.env.TABORA_FILE_ROOTS_B64 -eq $taboraEncodedFileRoots -or $taboraTransport.env.TABORA_FILE_ROOTS -eq $env:TABORA_FILE_ROOTS)
      } else {
        $taboraSame = $taboraText.Contains($taboraNode) -and $taboraText.Contains($taboraMain) -and (-not $env:TABORA_STATE_DIR -or $taboraText.Contains($env:TABORA_STATE_DIR)) -and (-not $taboraEncodedFileRoots -or $taboraText.Contains($taboraEncodedFileRoots) -or $taboraText.Contains($env:TABORA_FILE_ROOTS))
      }
      if (-not $taboraSame) { throw "An existing $taboraClient MCP server named tabora-browser uses another configuration. Review it before removing or replacing it." }
      Write-Output "$taboraClient MCP already registered."
      continue
    }
    $taboraAdd = @('mcp','add')
    if ($taboraClient -eq 'claude') { $taboraAdd += @('--scope','user') }
    if ($env:TABORA_STATE_DIR) { $taboraAdd += @('--env',"TABORA_STATE_DIR=$env:TABORA_STATE_DIR") }
    if ($taboraEncodedFileRoots) { $taboraAdd += @('--env',"TABORA_FILE_ROOTS_B64=$taboraEncodedFileRoots") }
    # Claude --env is variadic, so a flag must delimit it before the name.
    if ($taboraClient -eq 'claude') { $taboraAdd += @('--transport','stdio') }
    $taboraAdd += @('tabora-browser','--',$taboraNode,$taboraMain)
    & $taboraCli.Source @taboraAdd
    if ($LASTEXITCODE -ne 0) { throw "$taboraClient MCP registration failed." }
  }
  if ($Managed) {
    & $taboraNode (Join-Path $taboraRoot 'node_modules\playwright\cli.js') install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Chromium installation failed.' }
    $taboraBrowserArgs = @((Join-Path $PSScriptRoot 'browser.mjs'),'start','--profile',$Profile)
    foreach ($taboraOrigin in $AllowOrigin) { $taboraBrowserArgs += @('--allow-origin',$taboraOrigin) }
    if ($Headless) { $taboraBrowserArgs += '--headless' }
    & $taboraNode @taboraBrowserArgs
    if ($LASTEXITCODE -ne 0) { throw 'Managed browser startup failed.' }
  } elseif ($AllowOrigin.Count -or $Headless) { throw '-AllowOrigin and -Headless require -Managed.' }
  $taboraDoctorArgs = @((Join-Path $PSScriptRoot 'doctor.mjs'))
  if ($Managed) { $taboraDoctorArgs += '--require-profile' }
  & $taboraNode @taboraDoctorArgs
  if ($LASTEXITCODE -ne 0) { throw 'Health check failed.' }
  Write-Output 'Tabora is ready. Restart your MCP client to discover the server. See README.md for usage.'
} finally { Pop-Location; $env:TABORA_FILE_ROOTS = $taboraOldFileRoots }
