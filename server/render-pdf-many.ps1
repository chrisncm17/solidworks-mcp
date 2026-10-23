param([string]$InputPath,[string]$OutputDir,[string]$Pages,[int]$Width=600,[string]$Prefix='p')
# v3.7: render several PDF pages in ONE process (WinRT start-up costs ~2 s per call). Writes <OutputDir>\<Prefix><page>.png
# and prints one JSON line per page: {"page":n,"path":...,"width":w,"height":h,"width_mm":..,"height_mm":..}
$ErrorActionPreference='Stop'
$allowed=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'generated\drawing_read'))
$out=[IO.Path]::GetFullPath($OutputDir)
# v3.7 review: real boundary (a sibling folder sharing the prefix is not inside) and no junction on the way
if(-not ($out.Equals($allowed,[StringComparison]::OrdinalIgnoreCase) -or $out.StartsWith($allowed.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase))) {throw 'Salida permitida solo dentro de generated/drawing_read'}
if($Width -lt 50 -or $Width -gt 3000) {throw 'Width debe estar entre 50 y 3000'}
if($Prefix -notmatch '^[A-Za-z0-9_-]{1,40}$') {throw 'Prefix inválido'}
New-Item -ItemType Directory -Force $out | Out-Null
$probe=$out; while($probe.Length -ge $allowed.Length) { if(((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Directorio de salida redirigido (junction): rechazado'}; $probe=[IO.Path]::GetDirectoryName($probe) }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
function AwaitOperation($Operation,[Type]$ResultType) {
    $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 } | Select-Object -First 1
    $task=$method.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
    $task.GetAwaiter().GetResult()
}
$actionMethod=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
$file=AwaitOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($InputPath)) ([Windows.Storage.StorageFile])
$doc=AwaitOperation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$list=@()
if($Pages -eq '' -or $Pages -eq 'all') { $list=1..$doc.PageCount } else {
  foreach($part in $Pages.Split(',')) { if($part -match '^(\d+)-(\d+)$') { $list+= [int]$Matches[1]..[int]$Matches[2] } elseif($part -match '^\d+$') { $list+= [int]$part } else { throw "Páginas inválidas: $part" } } }
foreach($n in $list) {
  if($n -lt 1 -or $n -gt $doc.PageCount) { continue }
  $pdfPage=$doc.GetPage($n-1); $stream=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  try {
    $options=New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $rw=$pdfPage.Size.Width; $rh=$pdfPage.Size.Height
    $options.DestinationWidth=$Width; $options.DestinationHeight=[uint32][Math]::Max(1,[Math]::Round($Width*$rh/$rw))
    ($actionMethod.Invoke($null,@($pdfPage.RenderToStreamAsync($stream,$options)))).GetAwaiter().GetResult() | Out-Null
    $stream.Seek(0)
    $path=Join-Path $out ("{0}{1}.png" -f $Prefix,$n)
    $in=[System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream); $fs=[System.IO.File]::Create($path)
    try {$in.CopyTo($fs)} finally {$fs.Dispose(); $in.Dispose()}
    '{{"page":{0},"path":"{1}","width":{2},"height":{3},"width_mm":{4},"height_mm":{5}}}' -f $n,($path -replace '\\','\\'),$options.DestinationWidth,$options.DestinationHeight,([Math]::Round($rw*25.4/96,2)).ToString([Globalization.CultureInfo]::InvariantCulture),([Math]::Round($rh*25.4/96,2)).ToString([Globalization.CultureInfo]::InvariantCulture)
  } finally { $stream.Dispose(); $pdfPage.Dispose() }
}
