# Optical media simulation

New to this test harness? Read `test-harness/README.md`'s "How it all fits together" and "Your first run, step
by step" sections first - everything below assumes you already know the big picture.

This lets you test the "insert a disc" part of the app **without any physical disc or burner** — by making a
single file (a `.iso`) look exactly like a real inserted disc to Windows.

## The idea, explained simply

An `.iso` file is just a single file containing an exact, byte-for-byte copy of everything that would be on an
optical disc — folders, files, all of it, packed into one file. "Mounting" that file means telling Windows
"pretend this file just got inserted as a disc" — the exact same thing that happens automatically when you
double-click an `.iso` in File Explorer and a new drive letter (like `E:`) appears.

Because Windows treats a mounted `.iso` *exactly* the same as a real disc — same drive letter, same file system,
same everything — the app genuinely cannot tell the difference. So this isn't a shortcut or a fake version of
the "read from a disc" feature; it exercises the real thing, just without needing an actual disc or drive.

Two PowerShell commands do all the actual work here, and they're both built into Windows already — nothing gets
installed:
- `Mount-DiskImage` — makes the `.iso` appear as a drive letter (like double-clicking it in Explorer).
- `Dismount-DiskImage` — makes that drive letter disappear again, cleanly, leaving nothing behind.

Building the `.iso` file itself uses a Windows-only technical detail (a component called `IMAPI2FS`) explained
in full inside `OpticalMediaTestKit.psm1`, if you're curious — you don't need to understand it to use this.

No admin rights are needed, nothing gets installed, and nothing outside the exact file path you give it is ever
touched.

## ⚠️ One thing you may need to do the first time: PowerShell's script-safety setting

PowerShell files (like `OpticalMediaTestKit.psm1`) are, by default on Windows, treated a bit like email
attachments — Windows won't just run one you didn't explicitly approve, even one you wrote yourself. If you see
an error like:

```
... cannot be loaded because running scripts is disabled on this system ...
```

that's this safety setting, not a real problem with the script. Two ways around it:
- **For one single use**: start PowerShell with an extra flag, `powershell -ExecutionPolicy Bypass`, which only
  affects that one PowerShell window and changes nothing permanent. (This is exactly what
  `test-harness/ui/iso-disc.js` already does automatically for you, if you're using it through that script
  rather than typing PowerShell commands yourself.)
- **To stop it asking every time**, run this once, yourself, in a PowerShell window:
  `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` — this is a normal, common one-time setup step for
  running your own PowerShell scripts, and only affects your own user account.

## How to use it

```powershell
Import-Module .\test-harness\optical-media\OpticalMediaTestKit.psm1
```
("Import-Module" just means "load this toolbox of commands so I can use them below.")

```powershell
# 1. Build a .iso from a folder (e.g. one of the per-disc folders the app's own partitioning produces)
$iso = New-TestIso -SourceDir "C:\...\disc1-files" -IsoPath "C:\...\fixtures\disc1.iso" -VolumeName "DISC1"

# 2. Mount it - the app will now detect it exactly like a real inserted disc
$drive = Mount-TestIso -IsoPath $iso.IsoPath
# ... now go use the app's recovery screen, or run another script that talks to it ...

# 3. Dismount when done with that "disc"
Dismount-TestIso -IsoPath $iso.IsoPath

# Sanity check what the app would currently see (the exact same check it uses internally):
Get-MountedTestOpticalDrives
```

For a backup spread across several discs, just repeat steps 1–3 once per disc's folder — only one virtual disc
needs to be "inserted" at a time, same as with real discs.

## Safety notes

- `New-TestIso` will never silently overwrite an existing file — you have to explicitly pass `-Force` for that,
  and even then it only ever removes that one exact file, nothing else.
- `New-TestIso` refuses to write into your home folder, Desktop/Documents/Downloads, or system folders, even if
  you point it there by accident.
- `Mount-TestIso`/`Dismount-TestIso` only ever affect the one virtual drive tied to the specific `.iso` file you
  give it — never a real physical drive.
- `Dismount-TestIso` is safe to call even if that disc is already dismounted (it just says so, rather than
  erroring) — handy so you can always call it at the end of a script "just in case" without worrying.

## Verified working

Built a `.iso` from a folder (including a subfolder inside it), mounted it, confirmed Windows reports it exactly
the way it would a real disc (via the same check the app itself uses), confirmed the files on the mounted drive
matched exactly, dismounted it cleanly, confirmed dismounting twice in a row doesn't error, and confirmed the
safety checks above correctly refuse when they should.
