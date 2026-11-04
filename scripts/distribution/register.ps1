param([switch]$Unregister,[switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$taboraRoot = [IO.Path]::GetFullPath($env:TABORA_INSTALL_ROOT)
if ($CheckOnly) {
  if ($env:TABORA_PREFLIGHT_EXTENSION_ID -notmatch '^[a-p]{32}$') { throw 'invalid_extension_id' }
  $taboraConfig = @{extensionId=$env:TABORA_PREFLIGHT_EXTENSION_ID}
} else { $taboraConfig = Get-Content -LiteralPath (Join-Path $taboraRoot 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
$taboraLauncher = Join-Path $taboraRoot 'tabora.exe'
$taboraManifest = Join-Path $taboraRoot 'native-host.json'
$taboraPreviousManifest = $null
if ($env:TABORA_MIGRATE_FROM) { $taboraPreviousManifest = Join-Path ([IO.Path]::GetFullPath($env:TABORA_MIGRATE_FROM)) 'dist\native-host\com.tabora.browser.json' }
$taboraBrowsers = @('Google\Chrome','Microsoft\Edge','Chromium')
foreach ($taboraBrowser in $taboraBrowsers) {
  $taboraKey = "HKCU:\Software\$taboraBrowser\NativeMessagingHosts\com.tabora.browser"
  if (Test-Path -LiteralPath $taboraKey) {
    $taboraExisting = (Get-Item -LiteralPath $taboraKey).GetValue('')
    if (-not $Unregister -and $taboraExisting -ne $taboraManifest -and (-not $taboraPreviousManifest -or $taboraExisting -ne $taboraPreviousManifest)) { throw 'native_registration_conflict: use explicit migration from the registered source checkout.' }
  }
}
$taboraClients = @()
foreach ($taboraName in @('codex','claude')) {
  $taboraCli = Get-Command $taboraName -ErrorAction SilentlyContinue
  if (-not $taboraCli) { continue }
  $taboraGetArgs = @('mcp','get','tabora-browser')
  if ($taboraName -eq 'codex') { $taboraGetArgs += '--json' }
  $ErrorActionPreference = 'Continue'
  try { $taboraOutput = & $taboraCli.Source @taboraGetArgs 2>$null; $taboraExit = $LASTEXITCODE } finally { $ErrorActionPreference = 'Stop' }
  $taboraSame = $false; $taboraMigrate = $false; $taboraPreserved = @{}; $taboraTransport = $null
  if ($taboraExit -eq 0) {
    if ($taboraName -eq 'codex') {
      $taboraTransport = ($taboraOutput -join "`n" | ConvertFrom-Json).transport
      $taboraSame = $taboraTransport.command -eq $taboraLauncher -and @($taboraTransport.args).Count -eq 1 -and $taboraTransport.args[0] -eq 'mcp'
      if (-not $taboraSame -and $env:TABORA_MIGRATE_FROM) {
        $taboraMigrate = [IO.Path]::GetFileName($taboraTransport.command) -in @('node','node.exe') -and @($taboraTransport.args).Count -eq 1 -and $taboraTransport.args[0] -eq (Join-Path $env:TABORA_MIGRATE_FROM 'dist\host\mcp.js')
        foreach ($taboraProperty in $taboraTransport.env.PSObject.Properties) {
          if ($taboraProperty.Name -notin @('TABORA_STATE_DIR','TABORA_FILE_ROOTS','TABORA_FILE_ROOTS_B64','TABORA_UPDATE_CHECK')) { throw 'migration_environment_review_required' }
          $taboraPreserved[$taboraProperty.Name] = [string]$taboraProperty.Value
        }
      }
    } else {
      $taboraLines = @(($taboraOutput -join "`n") -split "`n")
      $taboraCommandLines = @($taboraLines | Where-Object { $_ -match '^\s*Command:\s*(.+?)\s*$' })
      $taboraArgumentLines = @($taboraLines | Where-Object { $_ -match '^\s*Args:\s*(.*?)\s*$' })
      $taboraUserScope = @($taboraLines | Where-Object { $_ -match '^\s*Scope:\s*User config\b' }).Count -eq 1
      if ($taboraCommandLines.Count -eq 1 -and $taboraArgumentLines.Count -eq 1 -and $taboraUserScope) {
        $taboraCommand = ($taboraCommandLines[0] -replace '^\s*Command:\s*','').Trim().Trim('"')
        $taboraArguments = ($taboraArgumentLines[0] -replace '^\s*Args:\s*','').Trim()
        $taboraSame = $taboraCommand -eq $taboraLauncher -and $taboraArguments -eq 'mcp'
      }
      if (-not $taboraSame -and -not $Unregister) { throw 'claude_existing_registration_review_required: identity/scope could not be verified; existing configuration has not been changed.' }
    }
    if (-not $taboraSame -and -not $taboraMigrate -and -not $Unregister) { throw 'mcp_registration_conflict' }
  }
  $taboraClients += @{Name=$taboraName;Path=$taboraCli.Source;Exists=($taboraExit -eq 0);Same=$taboraSame;Migrate=$taboraMigrate;Environment=$taboraPreserved;Original=$taboraTransport}
}
if ($CheckOnly) { exit }
if ($Unregister) {
  foreach ($taboraClient in $taboraClients) {
    if ($taboraClient.Same) {
      $taboraRemove = @('mcp','remove','tabora-browser')
      if ($taboraClient.Name -eq 'claude') { $taboraRemove += @('--scope','user') }
      & $taboraClient.Path @taboraRemove
      if ($LASTEXITCODE -ne 0) { throw 'mcp_unregister_failed' }
    }
  }
  foreach ($taboraBrowser in $taboraBrowsers) {
    $taboraKey = "HKCU:\Software\$taboraBrowser\NativeMessagingHosts\com.tabora.browser"
    if ((Test-Path -LiteralPath $taboraKey) -and (Get-Item -LiteralPath $taboraKey).GetValue('') -eq $taboraManifest) { Remove-Item -LiteralPath $taboraKey }
  }
  Write-Output 'Owned registrations removed. User data retained.'
  exit
}
$taboraDefinition = @{name='com.tabora.browser';description='Tabora Browser';path=$taboraLauncher;type='stdio';allowed_origins=@("chrome-extension://$($taboraConfig.extensionId)/")}
[IO.File]::WriteAllText($taboraManifest, ($taboraDefinition | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
foreach ($taboraBrowser in $taboraBrowsers) {
  $taboraKey = "HKCU:\Software\$taboraBrowser\NativeMessagingHosts\com.tabora.browser"
  New-Item -Path $taboraKey -Force | Out-Null
  Set-Item -LiteralPath $taboraKey -Value $taboraManifest
}
foreach ($taboraClient in $taboraClients) {
  if ($taboraClient.Same) { continue }
  if ($taboraClient.Migrate) { & $taboraClient.Path mcp remove tabora-browser; if ($LASTEXITCODE -ne 0) { throw 'mcp_migration_remove_failed' } }
  $taboraAdd = @('mcp','add')
  if ($taboraClient.Name -eq 'claude') { $taboraAdd += @('--scope','user') }
  foreach ($taboraEntry in $taboraClient.Environment.GetEnumerator()) { $taboraAdd += @('--env',"$($taboraEntry.Key)=$($taboraEntry.Value)") }
  if ($taboraClient.Name -eq 'claude') { $taboraAdd += @('--transport','stdio') }
  $taboraAdd += @('tabora-browser','--',$taboraLauncher,'mcp')
  & $taboraClient.Path @taboraAdd
  if ($LASTEXITCODE -ne 0) {
    if ($taboraClient.Migrate) {
      $taboraRestore = @('mcp','add')
      foreach ($taboraEntry in $taboraClient.Environment.GetEnumerator()) { $taboraRestore += @('--env',"$($taboraEntry.Key)=$($taboraEntry.Value)") }
      $taboraRestore += @('tabora-browser','--',$taboraClient.Original.command) + @($taboraClient.Original.args)
      & $taboraClient.Path @taboraRestore
      if ($LASTEXITCODE -ne 0) { throw 'mcp_migration_restore_failed: restore the original reviewed configuration before continuing.' }
    }
    throw 'mcp_registration_failed: native registration is installed; repair after resolving the client error.'
  }
}
Write-Output 'Tabora registrations installed. Reconnect MCP and load extension-unpacked once in the intended browser profile.'
