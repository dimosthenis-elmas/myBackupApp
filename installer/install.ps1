#Requires -Version 5.1
<#
.SYNOPSIS
  A simple, portable installer for this app - no admin rights, no registry entries, no Program Files.

.DESCRIPTION
  Copies the already-built dist\win-unpacked folder into a directory YOU choose, optionally records the paths
  to your 7z.exe and ImgBurn.exe into the copied appData\config.json, and (optionally) creates a Desktop-or-
  wherever-you-choose shortcut to the installed .exe. Nothing is written outside the folder you pick - no
  registry keys, no Start Menu entries, no per-machine install. Uninstalling is just deleting that folder (and
  the shortcut, if you made one).

  This script does NOT build the app - run `npm run electron:build` first (or `npm run build:prod` if
  dist\win-unpacked already exists from a previous build you trust). This just packages up what that already
  produced into a real, standalone install.

  The app's own real temp/cache directory (appData\config.json's cacheDataDirectoryPath) is left on its default
  value, which is a RELATIVE path resolved against the app's own appData folder - already portable by design
  (verified 2026-08-27: it resolves correctly no matter where the whole folder is copied to), so nothing needs
  to be done here to satisfy that.

.NOTES
  Run this by double-clicking install.bat (in the same folder), or directly:
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------------------------------------------
# 0. Locate the already-built win-unpacked folder (sibling to this script's own project root: installer\..\dist\
#    win-unpacked) - this script never builds anything itself, only packages what's already there.
# --------------------------------------------------------------------------------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$sourceDir = Join-Path $projectRoot 'dist\win-unpacked'

if (-not (Test-Path $sourceDir)) {
    [System.Windows.Forms.MessageBox]::Show(
        "Could not find a built app at:`n$sourceDir`n`nRun 'npm run electron:build' in the project folder first, then run this installer again.",
        'Nothing to install', 'OK', 'Error') | Out-Null
    exit 1
}

$sourceExe = Get-ChildItem -Path $sourceDir -Filter '*.exe' -File | Select-Object -First 1
if (-not $sourceExe) {
    [System.Windows.Forms.MessageBox]::Show(
        "Found $sourceDir, but no .exe file directly inside it. The build may be incomplete - try running 'npm run electron:build' again.",
        'Nothing to install', 'OK', 'Error') | Out-Null
    exit 1
}

# --------------------------------------------------------------------------------------------------------------
# 1. Ask where to install - a real folder-picker, not a text box. The "Make New Folder" button lets the user
#    create a fresh folder right from this dialog.
# --------------------------------------------------------------------------------------------------------------
$folderDialog = New-Object System.Windows.Forms.FolderBrowserDialog
$folderDialog.Description = "Select (or create) the folder where the app's files will go.`nEverything is self-contained in this one folder - to uninstall later, just delete it."
$folderDialog.ShowNewFolderButton = $true
if ($folderDialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host 'Installation canceled - no folder was chosen.'
    exit 0
}
$installDir = $folderDialog.SelectedPath

# Safety: if the chosen folder isn't empty, confirm before copying into it - avoid silently mixing app files
# into something that already has real content in it.
$existingItems = @(Get-ChildItem -Path $installDir -Force -ErrorAction SilentlyContinue)
if ($existingItems.Count -gt 0) {
    $confirm = [System.Windows.Forms.MessageBox]::Show(
        "The folder you chose:`n$installDir`n`nalready contains $($existingItems.Count) item(s). The app's files will be copied in alongside whatever's already there (existing files with the same name will be overwritten).`n`nContinue?",
        'Folder is not empty', 'YesNo', 'Warning')
    if ($confirm -ne [System.Windows.Forms.DialogResult]::Yes) {
        Write-Host 'Installation canceled.'
        exit 0
    }
}

# --------------------------------------------------------------------------------------------------------------
# 2. Copy the built app in.
# --------------------------------------------------------------------------------------------------------------
Write-Host "Copying app files to $installDir ..."
Copy-Item -Path (Join-Path $sourceDir '*') -Destination $installDir -Recurse -Force
$installedExePath = Join-Path $installDir $sourceExe.Name
if (-not (Test-Path $installedExePath)) {
    [System.Windows.Forms.MessageBox]::Show("Copy finished, but $installedExePath is missing - something went wrong. Nothing else will be done.", 'Copy failed', 'OK', 'Error') | Out-Null
    exit 1
}
Write-Host '  done.'

# --------------------------------------------------------------------------------------------------------------
# 3. Ask for 7z.exe / ImgBurn.exe - both optional (Cancel leaves that one unset; the app itself will ask again
#    the first time it's actually needed, the same way it already does today for a missing/invalid path).
# --------------------------------------------------------------------------------------------------------------
function Select-ExecutableFile {
    param([string]$Title)
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = $Title
    $dlg.Filter = 'Executable files (*.exe)|*.exe|All files (*.*)|*.*'
    $dlg.CheckFileExists = $true
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        return $dlg.FileName
    }
    return $null
}

Write-Host "`nSelect your 7z.exe (Cancel to skip and set this later, inside the app)..."
$sevenZipPath = Select-ExecutableFile -Title 'Select 7z.exe (Cancel to skip for now)'

Write-Host 'Select your ImgBurn.exe (Cancel to skip and set this later, inside the app)...'
$imgBurnPath = Select-ExecutableFile -Title 'Select ImgBurn.exe (Cancel to skip for now)'

# --------------------------------------------------------------------------------------------------------------
# 4. Write the chosen paths into the COPIED config.json - never the project's own appData/config.json, only the
#    installed copy. cacheDataDirectoryPath is deliberately left untouched (its default is already a relative
#    path, resolved against the app's own appData folder - already portable, see this script's own header).
# --------------------------------------------------------------------------------------------------------------
$configPath = Join-Path $installDir 'resources\appData\config.json'
if (Test-Path $configPath) {
    Write-Host "`nUpdating $configPath ..."
    $config = Get-Content -Path $configPath -Raw | ConvertFrom-Json
    if ($sevenZipPath) { $config._7zipExecutablePath = $sevenZipPath }
    if ($imgBurnPath) { $config.imgBurnExecutablePath = $imgBurnPath }
    # The app's own first-run flow (checked on every startup) treats this as "the user already went through
    # setup" - since this installer just did the equivalent of that, set it the same way a normal first run
    # would once the user clicks through it.
    $config | Add-Member -NotePropertyName 'setupAcknowledged' -NotePropertyValue $true -Force
    # NOT `Set-Content -Encoding UTF8` - PowerShell 5.1's "UTF8" encoding writes a UTF-8 BOM, and the app's own
    # readConfig() (worker.ts) reads config.json with fs.readFileSync (no encoding specified) then passes the
    # result straight to JSON.parse, which does NOT tolerate a leading BOM - it throws, and readConfig()'s catch
    # block silently swallows that into an empty {} config. Found for real (2026-08-27): every value this
    # installer wrote (both executable paths AND setupAcknowledged) was invisible to the app on its very first
    # read because of this - it only "fixed itself" once the app's own first-run flow re-prompted and rewrote
    # the file itself (via plain fs.promises.writeFile, no BOM). [System.IO.File]::WriteAllText with an explicit
    # UTF8Encoding($false) writes UTF-8 with NO BOM, which JSON.parse reads correctly - reproduced and confirmed
    # via a standalone Node script that mirrors the app's exact read path before landing on this fix.
    $jsonText = $config | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($configPath, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host '  done.'
} else {
    Write-Host "`nWARNING: $configPath was not found in the copied files - could not save the 7z/ImgBurn paths. The app will ask for them itself on first run."
}

# --------------------------------------------------------------------------------------------------------------
# 5. Offer a shortcut - defaults to the Desktop, but the folder picker lets the user put it anywhere (or cancel
#    to skip entirely).
# --------------------------------------------------------------------------------------------------------------
$makeShortcut = [System.Windows.Forms.MessageBox]::Show('Create a shortcut to the app?', 'Shortcut', 'YesNo', 'Question')
if ($makeShortcut -eq [System.Windows.Forms.DialogResult]::Yes) {
    $shortcutFolderDialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $shortcutFolderDialog.Description = 'Where should the shortcut go? (Defaults to your Desktop - click OK to accept, or browse elsewhere.)'
    $shortcutFolderDialog.SelectedPath = [Environment]::GetFolderPath('Desktop')
    if ($shortcutFolderDialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $shortcutDir = $shortcutFolderDialog.SelectedPath
        $shortcutName = [System.IO.Path]::GetFileNameWithoutExtension($sourceExe.Name)
        $shortcutPath = Join-Path $shortcutDir "$shortcutName.lnk"
        $wshShell = New-Object -ComObject WScript.Shell
        $shortcut = $wshShell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $installedExePath
        $shortcut.WorkingDirectory = $installDir
        $shortcut.IconLocation = $installedExePath
        $shortcut.Save()
        Write-Host "`nShortcut created at $shortcutPath"
    } else {
        Write-Host "`nShortcut skipped."
    }
} else {
    Write-Host "`nShortcut skipped."
}

# --------------------------------------------------------------------------------------------------------------
# 6. Done.
# --------------------------------------------------------------------------------------------------------------
$summary = "Installed to:`n$installDir`n`n" +
    "7z.exe:     $(if ($sevenZipPath) { $sevenZipPath } else { '(not set - the app will ask on first use)' })`n" +
    "ImgBurn.exe: $(if ($imgBurnPath) { $imgBurnPath } else { '(not set - the app will ask on first use)' })`n`n" +
    "To uninstall later: just delete the folder above (and the shortcut, if you made one). Nothing else was changed on this computer - no registry entries, no Program Files."
[System.Windows.Forms.MessageBox]::Show($summary, 'Installation complete', 'OK', 'Information') | Out-Null
Write-Host "`nDone."
