# Packs the plugin into dist/<id>.zip for a GitHub release.
# The zip holds a single <id>/ folder with manifest.json, main.js and
# styles.css, so users can unzip it straight into <vault>/.obsidian/plugins/.
#
# Usage:  ./release.ps1
#
# Obsidian's installer downloads the three loose files from the release, so
# attach them alongside the zip (the script prints the gh command).

$ErrorActionPreference = 'Stop'

$root     = $PSScriptRoot
$files    = @('manifest.json', 'main.js', 'styles.css')
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$id       = $manifest.id
$version  = $manifest.version

$dist = Join-Path $root 'dist'
$zip  = Join-Path $dist "$id.zip"

foreach ($f in $files) {
    if (-not (Test-Path (Join-Path $root $f))) { throw "Missing $f in $root" }
}
New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $zip) { Remove-Item -Force $zip }

# Entries are added by hand with '/' separators: Compress-Archive and
# ZipFile.CreateFromDirectory write '\' on Windows PowerShell 5.1, which
# unzips into wrongly named files on macOS/Linux.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
    foreach ($f in $files) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, (Join-Path $root $f), "$id/$f", 'Optimal') | Out-Null
    }
}
finally {
    $archive.Dispose()
}

Write-Host "$id $version -> $zip" -ForegroundColor Green
Write-Host "Publish: gh release create $version $($files -join ' ') dist/$id.zip" -ForegroundColor DarkGray
