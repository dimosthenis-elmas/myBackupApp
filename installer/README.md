# Portable installer

A simple, portable installer for this app - no admin rights, no registry entries, no Program Files, no
Add/Remove Programs entry. You pick a folder, everything the app needs goes into it, and (optionally) a
shortcut gets created wherever you choose. To uninstall, delete that one folder (and the shortcut, if you made
one) - nothing else on the machine is touched.

This deliberately does **not** use the existing NSIS-based `npm run electron:build` installer output (the
`...Setup....exe` in `release\`) - that one installs per-user to a fixed `%LOCALAPPDATA%\Programs\...` location and
writes an uninstaller registry entry, which is the opposite of what this is for. It also isn't an MSI - MSI
packages always register themselves in the Windows Installer database and the registry (that's inherent to the
format, not something you can opt out of), so it can't be made portable in this sense either.

## How to use it

1. Build the app first, the normal way:
   ```
   npm run electron:build
   ```
   (this produces `release\win-unpacked\` - the installer doesn't build anything itself, it just packages up
   whatever is already there)
2. Double-click `install.bat` in this folder (or run `install.ps1` directly via
   `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`).
3. Follow the prompts:
   - Pick (or create) the folder you want the app installed into.
   - Choose whether to create a shortcut, and where (defaults to your Desktop).

7-Zip and ImgBurn are not asked for: the app finds them itself when it starts (in their folders under Program
Files, where their installers recorded them in the registry, or on the PATH), and asks you where they are only if
it cannot - see the README's startup checks.

## What it actually does

- Copies `release\win-unpacked\*` into the folder you chose (`Copy-Item -Recurse`).
- Leaves the copied `resources\appData\config.json` as it is, and `cacheDataDirectoryPath` on its default value. That default is a *relative* path, resolved against the
  app's own `appData` folder wherever it ends up - already portable by design (verified directly: copying
  `win-unpacked` anywhere and re-reading the config confirms it stays relative), so there's nothing to change
  here for the temp/cache files to end up inside the install folder.
- Creates a real Windows shortcut (`.lnk`, via the same `WScript.Shell` mechanism Windows' own shortcut creation
  uses) pointing at the installed `.exe`, if you asked for one.

## Why this works when the folder is moved

`app/main.ts` finds its compiled UI (`index.html`) via `process.resourcesPath` - Electron's own
install-location-independent API - rather than a path relative to where the app happened to be built. The
compiled Angular frontend is bundled as a proper resource for exactly this reason (`extraResources` in
`package.json`, landing at `resources\dist\index.html`), so copying `win-unpacked` anywhere else, as this
installer does, still finds it correctly. If `resources\dist\index.html` is missing from your
`release\win-unpacked\` folder, rebuild with `npm run electron:build` before installing - the app will load a
blank window without it.

## Known limitations / not yet verified

- The interactive GUI dialogs (folder pickers, message boxes) and the final "does the installed app actually
  show its UI and work correctly" check have not been run end-to-end by an actual person yet - only the
  underlying mechanics (the file copy, real shortcut creation and readback) have been verified directly, using the
  real project path. Please try a real install and let it be known how it goes.
- No uninstaller script is provided - per the whole point of this being portable, "uninstall" is just deleting
  the folder you installed into (and the shortcut, if you made one). Nothing else was ever written anywhere else.
- This only targets Windows (`WScript.Shell` for the shortcut, `.bat`/`.ps1` for the installer itself) - matching
  the rest of this project, which is Windows-only in practice (ImgBurn, optical media, etc.).
