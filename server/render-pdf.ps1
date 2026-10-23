param([string]$InputPath,[string]$OutputPath,[int]$Page=1,[int]$Width=1600,[string]$Region='')
$ErrorActionPreference='Stop'
$allowed=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'generated\drawing_read'))
if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputPath)) -ne $allowed -or [IO.Path]::GetExtension($OutputPath) -ne '.png') {throw 'Salida permitida solo en generated/drawing_read/*.png'}
if($Width -lt 1 -or $Width -gt 3000) {throw 'Width debe estar entre 1 y 3000'}
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
function AwaitOperation($Operation,[Type]$ResultType) {
    $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 } | Select-Object -First 1
    $task=$method.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
    $task.GetAwaiter().GetResult()
}
$file=AwaitOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($InputPath)) ([Windows.Storage.StorageFile])
$doc=AwaitOperation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
if($Page -lt 1 -or $Page -gt $doc.PageCount) { throw 'Página fuera de rango' }
$pdfPage=$doc.GetPage($Page-1)
$stream=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
try {
    $options=New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $rw=$pdfPage.Size.Width; $rh=$pdfPage.Size.Height
    if($Region) {
        $r=@($Region.Split(',') | ForEach-Object {[double]::Parse($_,[Globalization.CultureInfo]::InvariantCulture) * 96 / 25.4})
        if($r.Count -ne 4 -or $r[0] -lt 0 -or $r[1] -lt 0 -or $r[2] -le $r[0] -or $r[3] -le $r[1] -or $r[2] -gt $rw+0.05 -or $r[3] -gt $rh+0.05) {throw 'region_mm fuera de página'}
        $rect=New-Object Windows.Foundation.Rect
        $rect.X=$r[0]; $rect.Y=$r[1]; $rect.Width=$r[2]-$r[0]; $rect.Height=$r[3]-$r[1]
        $options.SourceRect=$rect
        $rw=$rect.Width; $rh=$rect.Height
    }
    if($Width*$rh/$rw -gt 12000) {throw 'Recorte demasiado alto; reduce width_px o la región'}
    $options.DestinationWidth=$Width
    $options.DestinationHeight=[uint32][Math]::Max(1,[Math]::Round($Width*$rh/$rw))
    $action=$pdfPage.RenderToStreamAsync($stream,$options)
    $actionMethod=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
    $renderTask=$actionMethod.Invoke($null,@($action))
    $renderTask.GetAwaiter().GetResult() | Out-Null
    $stream.Seek(0)
    $inputStream=[System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
    $out=[System.IO.File]::Create($OutputPath)
    try {$inputStream.CopyTo($out)} finally {$out.Dispose(); $inputStream.Dispose()}
} finally {$stream.Dispose(); $pdfPage.Dispose()}
