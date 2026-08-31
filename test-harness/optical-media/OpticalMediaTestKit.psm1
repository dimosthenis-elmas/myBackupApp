<#
.SYNOPSIS
  Simulates "insert an optical disc" for testing, without any physical media or burner.

.DESCRIPTION
  Builds small .iso files from a folder and mounts/dismounts them as virtual optical drives, using only
  built-in Windows features:
    - IMAPI2FS (the same COM component behind Explorer's "Burn disc image") to author the .iso.
    - Mount-DiskImage / Dismount-DiskImage (the same feature behind double-clicking an .iso in Explorer) to
      make it appear as a drive letter and go away again.

  A mounted .iso is indistinguishable, from Windows' point of view, from a real optical disc: same DriveType (5),
  same CDFS filesystem, real Size/FreeSpace/VolumeName. The app's own drive-detection code (OPTICAL_DISC_POLL_SCRIPT
  in app/workers/worker.ts) just polls Win32_LogicalDisk for DriveType=5 with media loaded - it can't tell the
  difference, so this exercises the real detection/read code path, not a stand-in for it.

  No admin rights, no installed software, nothing outside the paths you explicitly pass in is ever touched.
  New-TestIso will refuse to overwrite an existing file unless you pass -Force, and only ever deletes the exact
  -IsoPath you gave it (never a directory, never anything else).

.EXAMPLE
  Import-Module .\test-harness\optical-media\OpticalMediaTestKit.psm1

  New-TestIso -SourceDir "C:\...\run-1.disc1" -IsoPath "C:\...\fixtures\disc1.iso" -VolumeName "DISC1"
  $drive = Mount-TestIso -IsoPath "C:\...\fixtures\disc1.iso"
  # ... point the app's recovery flow at $drive.DriveLetter, or just let it auto-detect ...
  Dismount-TestIso -IsoPath "C:\...\fixtures\disc1.iso"
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Compiled once per session. Uses System.Runtime.InteropServices.Marshal (AllocHGlobal/ReadInt32/FreeHGlobal) -
# standard, safe COM interop helpers - deliberately NOT the "unsafe"-keyword/raw-pointer style most examples of
# this online use. Functionally identical, no raw pointers appear anywhere in this code.
if (-not ([System.Management.Automation.PSTypeName]'OpticalMediaTestKit.IsoStreamWriter').Type) {
  $cs = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace OpticalMediaTestKit {
    public class IsoStreamWriter {
        /// <summary>Drains an IMAPI2FS result image's COM IStream to a file, one block at a time.</summary>
        public static void Create(string path, object streamObj, int blockSize, int totalBlocks) {
            IStream istream = streamObj as IStream;
            if (istream == null) { throw new InvalidOperationException("The supplied object is not an IStream."); }
            byte[] buf = new byte[blockSize];
            IntPtr pBytesRead = Marshal.AllocHGlobal(sizeof(int));
            try {
                using (FileStream o = new FileStream(path, FileMode.Create, FileAccess.Write)) {
                    for (int i = 0; i < totalBlocks; i++) {
                        istream.Read(buf, blockSize, pBytesRead);
                        int bytesRead = Marshal.ReadInt32(pBytesRead);
                        if (bytesRead <= 0) { break; }
                        o.Write(buf, 0, bytesRead);
                    }
                    o.Flush();
                }
            } finally {
                Marshal.FreeHGlobal(pBytesRead);
            }
        }
    }
}
'@
  Add-Type -TypeDefinition $cs -Language CSharp
}

<#
.SYNOPSIS
  Refuses obviously-unsafe output locations for a generated .iso (mirrors test-harness/lib/safety.js's
  resolveSafeRoot, applied to a single file path instead of a folder).
#>
function Test-SafeIsoOutputPath {
  param([Parameter(Mandatory)][string]$Path)

  $resolved = [System.IO.Path]::GetFullPath($Path)
  $parent = Split-Path -Parent $resolved
  $driveRoot = [System.IO.Path]::GetPathRoot($resolved)

  if (-not $parent -or $parent -eq $driveRoot) {
    throw "Refusing to write an ISO directly at a drive root: `"$resolved`". Use a nested folder."
  }

  $blocked = @(
    $env:USERPROFILE,
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:USERPROFILE 'Documents'),
    (Join-Path $env:USERPROFILE 'Downloads'),
    'C:\Windows', 'C:\Program Files', 'C:\Program Files (x86)', 'C:\ProgramData', 'C:\Users'
  ) | ForEach-Object { [System.IO.Path]::GetFullPath($_).ToLowerInvariant() }

  if ($blocked -contains $parent.ToLowerInvariant()) {
    throw "Refusing to write an ISO directly into a protected system/user folder: `"$parent`". Use a nested test folder instead."
  }

  return $resolved
}

function New-TestIso {
  <#
  .SYNOPSIS
    Builds a .iso image from a folder's contents (recursively).
  .PARAMETER SourceDir
    Folder whose contents become the disc's root. Not modified in any way - only read.
  .PARAMETER IsoPath
    Where to write the .iso. Must not already exist unless -Force is passed; if -Force is passed, only this
    exact file is deleted before writing the new one (nothing else, ever).
  .PARAMETER VolumeName
    Disc volume label. Defaults to "TESTDISC". Truncated to 32 chars (Joliet limit).
  #>
  param(
    [Parameter(Mandatory)][string]$SourceDir,
    [Parameter(Mandatory)][string]$IsoPath,
    [string]$VolumeName = 'TESTDISC',
    [switch]$Force
  )

  if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    throw "SourceDir does not exist or is not a folder: `"$SourceDir`""
  }

  $resolvedIsoPath = Test-SafeIsoOutputPath -Path $IsoPath

  if (Test-Path -LiteralPath $resolvedIsoPath) {
    if (-not $Force) {
      throw "`"$resolvedIsoPath`" already exists. Pass -Force to overwrite (only this exact file is deleted, nothing else)."
    }
    Remove-Item -LiteralPath $resolvedIsoPath -Force
  }

  $parentDir = Split-Path -Parent $resolvedIsoPath
  if (-not (Test-Path -LiteralPath $parentDir)) {
    New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
  }

  $fsi = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
  $fsi.VolumeName = $VolumeName.Substring(0, [Math]::Min(32, $VolumeName.Length))
  $fsi.FileSystemsToCreate = 3   # ISO9660 + Joliet (Joliet carries full Unicode names, e.g. the generator's edge-case filenames)
  $fsi.Root.AddTree($SourceDir, $false)

  $resultImage = $fsi.CreateResultImage()
  $blockSize = $resultImage.BlockSize
  $totalBlocks = $resultImage.TotalBlocks

  [OpticalMediaTestKit.IsoStreamWriter]::Create($resolvedIsoPath, $resultImage.ImageStream, $blockSize, $totalBlocks)

  $sizeBytes = (Get-Item -LiteralPath $resolvedIsoPath).Length
  Write-Host "Created ISO: $resolvedIsoPath ($sizeBytes bytes, volume `"$($fsi.VolumeName)`")"
  return [PSCustomObject]@{ IsoPath = $resolvedIsoPath; SizeBytes = $sizeBytes; VolumeName = $fsi.VolumeName }
}

function Mount-TestIso {
  <#
  .SYNOPSIS
    Mounts a .iso as a virtual optical drive and returns its assigned drive letter/info once ready.
    Equivalent to double-clicking the .iso in Explorer. Fully reversible - see Dismount-TestIso.
  #>
  param(
    [Parameter(Mandatory)][string]$IsoPath,
    [int]$TimeoutSeconds = 15
  )

  if (-not (Test-Path -LiteralPath $IsoPath -PathType Leaf)) {
    throw "IsoPath does not exist: `"$IsoPath`""
  }

  Mount-DiskImage -ImagePath $IsoPath | Out-Null

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $vol = Get-DiskImage -ImagePath $IsoPath | Get-Volume -ErrorAction SilentlyContinue
    if ($vol -and $vol.DriveLetter) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)

  if (-not $vol -or -not $vol.DriveLetter) {
    throw "Mounted `"$IsoPath`" but no drive letter appeared within $TimeoutSeconds seconds."
  }

  $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$($vol.DriveLetter):'"
  Write-Host "Mounted `"$IsoPath`" as $($vol.DriveLetter): (VolumeName=$($disk.VolumeName), Size=$($disk.Size))"
  return [PSCustomObject]@{
    DriveLetter = "$($vol.DriveLetter):"
    VolumeName  = $disk.VolumeName
    SizeBytes   = $disk.Size
    IsoPath     = $IsoPath
  }
}

function Dismount-TestIso {
  <#
  .SYNOPSIS
    Dismounts a previously mounted .iso, removing its virtual drive letter. Safe to call even if it's already
    dismounted (no-op with a message, not an error).
  #>
  param([Parameter(Mandatory)][string]$IsoPath)

  $img = Get-DiskImage -ImagePath $IsoPath -ErrorAction SilentlyContinue
  if (-not $img -or -not $img.Attached) {
    Write-Host "`"$IsoPath`" is not currently mounted - nothing to do."
    return
  }
  Dismount-DiskImage -ImagePath $IsoPath | Out-Null
  Write-Host "Dismounted `"$IsoPath`""
}

function Get-MountedTestOpticalDrives {
  <#
  .SYNOPSIS
    Read-only. Lists every drive Windows currently reports as an optical drive with media loaded - the exact
    same query the app's own detection code uses. Handy to sanity-check what the app would see right now,
    including any real physical drive.
  #>
  Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=5" |
    Select-Object DeviceID, FileSystem, Size, FreeSpace, VolumeName
}

Export-ModuleMember -Function New-TestIso, Mount-TestIso, Dismount-TestIso, Get-MountedTestOpticalDrives
