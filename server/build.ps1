# Builds the CAD worker (Worker-equations.exe) from worker\*.cs with the .NET Framework 4 C# compiler that ships with Windows.
# The SolidWorks API is found in the registry / default install folder; SOLIDWORKS_API_REDIST overrides it
# (<SolidWorks install>\api\redist). If an MCP client is running the worker, the old exe is renamed first (Windows lets a
# running exe be renamed, not overwritten); delete the *.old-*.exe files later.
$ErrorActionPreference = 'Stop'
$redist = $env:SOLIDWORKS_API_REDIST
if (-not $redist) {
  $candidates = @('C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\api\redist')
  try {
    Get-ChildItem 'HKLM:\SOFTWARE\SolidWorks' -ErrorAction Stop | ForEach-Object {
      $setup = Get-ItemProperty "$($_.PSPath)\Setup" -ErrorAction SilentlyContinue
      if ($setup -and $setup.'SolidWorks Folder') { $candidates += (Join-Path $setup.'SolidWorks Folder' 'api\redist') }
    }
  } catch {}
  $redist = $candidates | Where-Object { Test-Path (Join-Path $_ 'SolidWorks.Interop.sldworks.dll') } | Select-Object -First 1
}
if (-not $redist) { throw 'SolidWorks API not found: set SOLIDWORKS_API_REDIST to <SolidWorks install>\api\redist' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $compiler)) { throw ".NET Framework 4 compiler not found: $compiler" }
$exe = Join-Path $PSScriptRoot 'Worker-equations.exe'
# compiled to a temporary file first: a failed build never removes the working worker
$tmp = Join-Path $PSScriptRoot 'Worker-equations.build.exe'
if (Test-Path $tmp) { Remove-Item $tmp }
# Worker.cs first: static fields of the partial class Worker are initialized in source order
$sources = Get-ChildItem (Join-Path $PSScriptRoot 'worker\*.cs') | Sort-Object { $_.Name -ne 'Worker.cs' }, Name | ForEach-Object { $_.FullName }
& $compiler /nologo /target:exe /platform:x64 /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.Xml.Linq.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll "/r:$redist\SolidWorks.Interop.sldworks.dll" "/r:$redist\SolidWorks.Interop.swconst.dll" "/out:$tmp" $sources
if ($LASTEXITCODE -ne 0) { if (Test-Path $tmp) { Remove-Item $tmp }; throw 'Worker compilation failed (the previous worker was kept)' }
if (Test-Path $exe) {
  try { Remove-Item $exe -ErrorAction Stop } catch { Rename-Item $exe ("Worker-equations.old-" + (Get-Date -Format yyyyMMddHHmmss) + ".exe") }
}
Move-Item $tmp $exe
foreach ($dll in 'SolidWorks.Interop.sldworks.dll', 'SolidWorks.Interop.swconst.dll') {
  $src = Join-Path $redist $dll; $dst = Join-Path $PSScriptRoot $dll
  if (!(Test-Path $dst) -or (Get-FileHash $src).Hash -ne (Get-FileHash $dst).Hash) { Copy-Item -LiteralPath $src -Destination $PSScriptRoot }
}
Write-Host "Worker built: $exe (SolidWorks API: $redist)"
