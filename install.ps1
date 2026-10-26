# One-line install (v3.11, idea from HarrierPigeon/Solidworks-MCP-Server):
#   powershell -ExecutionPolicy Bypass -File install.ps1                 # checks, npm install, build, tests, register in every client found
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Clients claude-code,codex -SkipTests
#   powershell -ExecutionPolicy Bypass -File install.ps1 -WhatIf          # show what it would do, change nothing
# Every client config it edits is backed up first (<file>.antes-solidworks-mcp-<date>.bak); an existing "solidworks" entry
# is replaced only with -Force. Nothing is uninstalled and SolidWorks is not started.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('claude-desktop', 'claude-code', 'codex')][string[]]$Clients = @('claude-desktop', 'claude-code', 'codex'),
  [string]$Name = 'solidworks',
  [switch]$SkipTests,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot; $server = Join-Path $root 'server\server.mjs'; $stamp = Get-Date -Format yyyyMMddHHmmss
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "   ok  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   !   $m" -ForegroundColor Yellow }
function Backup($file) { if (Test-Path $file) { $b = "$file.antes-solidworks-mcp-$stamp.bak"; Copy-Item $file $b; Ok "respaldo: $b" } }

Step 'Requisitos'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 18+ no encontrado (https://nodejs.org)' }
$nv = [int]((& node -v).TrimStart('v').Split('.')[0]); if ($nv -lt 18) { throw "Node.js $nv es viejo; se necesita 18 o más" }; Ok "Node.js $(& node -v)"
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "Compilador de .NET Framework 4 no encontrado: $csc" }; Ok '.NET Framework 4 (csc)'
$py = Get-Command python -ErrorAction SilentlyContinue
if ($py -and ((& python -c "import pypdf, PIL; print('ok')" 2>$null) -eq 'ok')) { Ok 'Python con pypdf y Pillow' } else { Warn 'Python con pypdf y Pillow no encontrado: la lectura de planos PDF/DXF no funcionará (pip install pypdf pillow)' }

Step 'Dependencias (npm install)'
if ($PSCmdlet.ShouldProcess($root, 'npm install')) { Push-Location $root; try { & npm install --no-fund --no-audit; if ($LASTEXITCODE) { throw 'npm install falló' } } finally { Pop-Location }; Ok 'node_modules' }

Step 'Worker de SolidWorks (npm run build)'
if ($PSCmdlet.ShouldProcess('server\Worker-equations.exe', 'build')) { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'server\build.ps1'); if ($LASTEXITCODE) { throw 'La compilación del worker falló' }; Ok 'Worker-equations.exe' }

if (-not $SkipTests) {
  Step 'Pruebas (sin SolidWorks)'
  if ($PSCmdlet.ShouldProcess('server\tests.mjs', 'node --test')) { Push-Location $root; try { & node --test server/tests.mjs | Select-String -Pattern '^# (pass|fail|skipped)' | ForEach-Object { "   $_" }; if ($LASTEXITCODE) { throw 'Hay pruebas fallando (usa -SkipTests para instalar igual)' } } finally { Pop-Location }; Ok 'pruebas' }
}

Step 'Registrar el servidor'
$entry = [ordered]@{ command = 'node'; args = @($server) }
foreach ($c in $Clients) {
  switch ($c) {
    'claude-desktop' {
      $file = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
      if (-not (Test-Path (Split-Path $file))) { Warn 'Claude Desktop no está instalado; omitido'; continue }
      $cfg = if (Test-Path $file) { Get-Content $file -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
      if (-not $cfg.PSObject.Properties['mcpServers']) { $cfg | Add-Member mcpServers ([pscustomobject]@{}) }
      $old = $cfg.mcpServers.PSObject.Properties[$Name]
      if ($old -and -not $Force) { Warn "Claude Desktop ya tiene '$Name' ($($old.Value.command) $($old.Value.args -join ' ')); usa -Force para reemplazarlo"; continue }
      if ($PSCmdlet.ShouldProcess($file, "mcpServers.$Name = node $server")) {
        Backup $file; $cfg.mcpServers | Add-Member -NotePropertyName $Name -NotePropertyValue ([pscustomobject]$entry) -Force
        [IO.File]::WriteAllText($file, ($cfg | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false)); Ok "Claude Desktop: $file (reinicia Claude Desktop)" }
    }
    'claude-code' {
      $claude = Get-Command claude -ErrorAction SilentlyContinue
      if (-not $claude) { Warn 'Claude Code (comando claude) no encontrado; omitido'; continue }
      # Windows PowerShell turns a native command's stderr into an error under Stop: ask through cmd and read only the exit code
      & cmd /c "claude mcp get $Name >nul 2>&1"; $exists = $LASTEXITCODE -eq 0
      if ($exists -and -not $Force) { Warn "Claude Code ya tiene '$Name'; usa -Force para reemplazarlo"; continue }
      if ($PSCmdlet.ShouldProcess('claude mcp', "add --scope user $Name")) {
        if ($exists) { & cmd /c "claude mcp remove $Name --scope user >nul 2>&1" }
        & cmd /c "claude mcp add --scope user $Name -- node `"$server`" 2>&1"; if ($LASTEXITCODE) { Warn 'claude mcp add falló' } else { Ok 'Claude Code (alcance user)' } }
    }
    'codex' {
      $file = Join-Path $env:USERPROFILE '.codex\config.toml'
      if (-not (Test-Path (Split-Path $file))) { Warn 'Codex no está instalado (~/.codex); omitido'; continue }
      $text = if (Test-Path $file) { Get-Content $file -Raw } else { '' }
      $hdr = "[mcp_servers.$Name]"
      if ($text -match [regex]::Escape($hdr) -and -not $Force) { Warn "Codex ya tiene $hdr; usa -Force para reemplazarlo"; continue }
      $block = "$hdr`ncommand = `"node`"`nargs = ['$server']`nstartup_timeout_sec = 60`ntool_timeout_sec = 900`n"
      if ($PSCmdlet.ShouldProcess($file, $hdr)) {
        Backup $file
        if ($text -match [regex]::Escape($hdr)) { $text = [regex]::Replace($text, "(?ms)^" + [regex]::Escape($hdr) + ".*?(?=^\[|\z)", $block) } else { $text = $text.TrimEnd() + "`n`n" + $block }
        [IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding $false)); Ok "Codex: $file" }
    }
  }
}
Step 'Listo'
Write-Host "   Pide al agente: sw_status y luego sw_exam_ready {start: true} (SolidWorks propio del MCP, minimizado)."
