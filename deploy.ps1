# Deploys the Metal Media Gallery plugin into a dev vault.
# Usage:  ./deploy.ps1                 deploy once to ./dev_vault
#         ./deploy.ps1 -Watch          deploy, then re-deploy on every change
#         ./deploy.ps1 -Vault "C:\Path\To\OtherVault"
#
# ./dev_vault is a local, git-ignored test vault — it is NOT part of the repo.
# Create it yourself (any Obsidian vault works) or pass -Vault to point
# elsewhere. The script throws if the target has no .obsidian folder.
#
# Note: galleries are now handled by the plugin in the repo root. The old CSS
# snippets (media-*.css) are superseded — disable them in Obsidian
# (Settings -> Appearance -> CSS snippets). This script no longer deploys them.

param(
    [string]$Vault = (Join-Path $PSScriptRoot 'dev_vault'),
    [switch]$Watch
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path (Join-Path $Vault '.obsidian'))) {
    throw "Not an Obsidian vault (no .obsidian folder): $Vault"
}

$pluginSrc   = $PSScriptRoot
$pluginId    = 'metal-media-gallery'
$pluginDst   = Join-Path $Vault ".obsidian\plugins\$pluginId"
$pluginFiles = @('manifest.json', 'main.js', 'styles.css')

function Invoke-Deploy {
    New-Item -ItemType Directory -Force -Path $pluginDst | Out-Null
    foreach ($f in $pluginFiles) {
        $src = Join-Path $pluginSrc $f
        if (Test-Path $src) {
            Copy-Item -Path $src -Destination (Join-Path $pluginDst $f) -Force
        }
    }
    Write-Host ("[{0:HH:mm:ss}] plugin -> {1}" -f (Get-Date), $pluginDst) -ForegroundColor Green

    # Ensure the plugin is enabled in community-plugins.json
    $cpFile = Join-Path $Vault '.obsidian\community-plugins.json'
    # ForEach-Object flattens the parsed array the same way in Windows PowerShell 5.1 and pwsh 7.
    $list = @(if (Test-Path $cpFile) { Get-Content $cpFile -Raw | ConvertFrom-Json | ForEach-Object { $_ } })
    if ($list -notcontains $pluginId) {
        $list += $pluginId
        # -InputObject keeps a one-item list a JSON array; piping would unwrap it to a string.
        # WriteAllText writes UTF-8 without the BOM that Set-Content adds on Windows PowerShell 5.1.
        [System.IO.File]::WriteAllText($cpFile, (ConvertTo-Json -InputObject @($list)))
        Write-Host "  enabled '$pluginId' in community-plugins.json" -ForegroundColor Yellow
    }
}

Invoke-Deploy

if (-not $Watch) {
    Write-Host "Reload Obsidian to pick up plugin changes (Ctrl+P -> 'Reload app without saving')." -ForegroundColor DarkGray
    return
}

Write-Host "Watching $pluginSrc for changes. Press Ctrl+C to stop." -ForegroundColor Cyan

$watcher = [System.IO.FileSystemWatcher]::new($pluginSrc)
# FileName too: some editors save by writing a temp file and renaming it over
# the original, which shows up as Renamed/Created rather than Changed.
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::FileName
$watcher.EnableRaisingEvents = $true
$kinds = [System.IO.WatcherChangeTypes]::Changed -bor [System.IO.WatcherChangeTypes]::Created -bor [System.IO.WatcherChangeTypes]::Renamed

try {
    while ($true) {
        $change = $watcher.WaitForChanged($kinds, 1000)
        if ($change.TimedOut -or $pluginFiles -notcontains $change.Name) { continue }
        Start-Sleep -Milliseconds 150   # let the editor finish writing
        try { Invoke-Deploy } catch { Write-Host "deploy failed: $_" -ForegroundColor Red }
    }
}
finally {
    $watcher.Dispose()
}
