$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot '..\physical-directory.ps1')
Resolve-TaboraPhysicalDirectory $env:TABORA_PHYSICAL_INPUT
