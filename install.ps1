# gs-ui-better installer - Windows.
# Copies the extensions into the Pi agent home and substitutes the one import that
# must point at the installed gentle-pi package.
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$Src = Split-Path -Parent $MyInvocation.MyCommand.Path
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# 1. Agent home: the same order Pi and Gentle Shell use.
if ($env:GENTLE_PI_AGENT_HOME) { $AgentHome = $env:GENTLE_PI_AGENT_HOME }
elseif ($env:PI_CODING_AGENT_DIR) { $AgentHome = $env:PI_CODING_AGENT_DIR }
elseif (Test-Path (Join-Path $HOME '.gentle-shell/agent')) { $AgentHome = Join-Path $HOME '.gentle-shell/agent' }
else { $AgentHome = Join-Path $HOME '.pi/agent' }

# 2. gentle-pi's card helpers: the file that carries the placeholder import.
$CardLib = $env:GS_UI_BETTER_SHELL_CARD
if (-not $CardLib) {
  $current = Join-Path $HOME '.gentle-shell/current/node_modules/gentle-pi/lib/shell-card.ts'
  if (Test-Path $current) { $CardLib = $current }
}
if (-not $CardLib) {
  $found = Get-ChildItem -Path (Join-Path $HOME '.gentle-shell/versions') -Filter shell-card.ts -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*gentle-pi*lib*' } | Sort-Object LastWriteTime | Select-Object -Last 1
  if ($found) { $CardLib = $found.FullName }
}
if (-not $CardLib) {
  $alt = Join-Path $AgentHome 'npm/node_modules/gentle-pi/lib/shell-card.ts'
  if (Test-Path $alt) { $CardLib = $alt }
}

Write-Host 'gs-ui-better'
Write-Host "  agent home : $AgentHome"
Write-Host ("  card lib   : " + $(if ($CardLib) { $CardLib } else { 'NOT FOUND' }))

if (-not (Test-Path $AgentHome)) {
  Write-Error "agent home does not exist: $AgentHome - open Gentle Shell once, or set GENTLE_PI_AGENT_HOME"
  exit 1
}

$ExtDir = Join-Path $AgentHome 'extensions'
$AssetDir = Join-Path $AgentHome 'assets/gentleman-greeting'
if ($DryRun) { Write-Host '  dry run    : nothing will be written' }
New-Item -ItemType Directory -Force -Path $ExtDir, $AssetDir | Out-Null

function Copy-Verbatim($name) {
  $target = Join-Path $ExtDir $name
  if (Test-Path $target) { if (-not $DryRun) { Copy-Item $target "$target.bak-$Stamp" } }
  if ($DryRun) { Write-Host "    would: copy $name" } else { Copy-Item (Join-Path $Src "extensions/$name") $target -Force }
  Write-Host "  installed  : extensions/$name"
}

# 3. Extensions. Every file but bash-one-line is copied verbatim.
Copy-Verbatim 'gentleman-greeting.ts'
Copy-Verbatim 'herdr-agent-state.ts'

$target = Join-Path $ExtDir 'bash-one-line.ts'
if (Test-Path $target) { if (-not $DryRun) { Copy-Item $target "$target.bak-$Stamp" } }
if (-not $CardLib) {
  Write-Host '  skipped    : extensions/bash-one-line.ts (shell-card.ts not found; Pi keeps its native cards)'
  Write-Host '               set GS_UI_BETTER_SHELL_CARD to the shell-card.ts path and rerun'
} else {
  if ($DryRun) {
    Write-Host '    would: write extensions/bash-one-line.ts with the resolved import'
  } else {
    $content = Get-Content (Join-Path $Src 'extensions/bash-one-line.ts') -Raw
    $content = $content -replace [regex]::Escape('__GS_UI_BETTER_SHELL_CARD__'), $CardLib
    Set-Content -Path $target -Value $content -NoNewline
  }
  Write-Host '  installed  : extensions/bash-one-line.ts'
}

# 4. Greeting assets, read from the same relative path at runtime.
Get-ChildItem (Join-Path $Src 'assets/gentleman-greeting') | ForEach-Object {
  if ($DryRun) { Write-Host "    would: copy $($_.Name)" } else { Copy-Item $_.FullName (Join-Path $AssetDir $_.Name) -Force }
}
Write-Host "  installed  : assets/gentleman-greeting/"

Write-Host ''
Write-Host 'Done. Restart Gentle Shell (or run /reload) to load the extensions.'
Write-Host 'Backups of replaced files were written next to them with a .bak-<timestamp> suffix.'
