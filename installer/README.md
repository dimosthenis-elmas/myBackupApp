# Portable installer

A simple, portable installer for this app - no admin rights, no registry entries, no Program Files, no
Add/Remove Programs entry. You pick a folder, everything the app needs goes into it, and (optionally) a
shortcut gets created wherever you choose. To uninstall, delete that one folder (and the shortcut, if you made
one) - nothing else on the machine is touched.

This deliberately does **not** use the existing NSIS-based `npm run electron:build` installer output (the
`...Setup....exe` in `dist\`) - that one installs per-user to a fixed `%LOCALAPPDATA%\Programs\...` location and
writes an uninstaller registry entry, which is the opposite of what this is for. It also isn't an MSI - MSI
packages always register themselves in the Windows Installer database and the registry (that's inherent to the
format, not something you can opt out of), so it can't be made portable in this sense either.

## How to use it

1. Build the app first, the normal way:
   ```
   npm run electron:build
   ```
   (this produces `dist\win-unpacked\` - the installer doesn't build anything itself, it just packages up
   whatever is already there)
2. Double-click `install.bat` in this folder (or run `install.ps1` directly via
   `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`).
3. Follow the prompts:
   - Pick (or create) the folder you want the app installed into.
   - Pick your `7z.exe` (or Cancel to skip - the app will ask again itself the first time it actually needs it,
     same as it already does today for a missing/invalid path).
   - Pick your `ImgBurn.exe` (same - Cancel to skip).
   - Choose whether to create a shortcut, and where (defaults to your Desktop).

## What it actually does

- Copies `dist\win-unpacked\*` into the folder you chose (`Copy-Item -Recurse`).
- Writes the 7z/ImgBurn paths you picked into the *copied* `resources\appData\config.json` (never touches the
  project's own `appData\config.json`), and sets `setupAcknowledged: true` - the same field the app's own
  first-run flow sets once you click through its own prompts, so it won't ask again unnecessarily.
- Leaves `cacheDataDirectoryPath` on its default value. That default is a *relative* path, resolved against the
  app's own `appData` folder wherever it ends up - already portable by design (verified directly: copying
  `win-unpacked` anywhere and re-reading the config confirms it stays relative), so there's nothing to change
  here for the temp/cache files to end up inside the install folder.
- Creates a real Windows shortcut (`.lnk`, via the same `WScript.Shell` mechanism Windows' own shortcut creation
  uses) pointing at the installed `.exe`, if you asked for one.

## A real portability bug this surfaced and fixed (see the project's own git history for the exact commit)

Building this exposed a genuine, pre-existing gap: `app/main.ts` used to find its own compiled UI (`index.html`)
via a relative-path guess that only worked by coincidence, because `dist\win-unpacked\` happened to sit inside
the same `dist\` folder that also holds the Angular build's own `index.html`. Copy `win-unpacked` anywhere else -
exactly what this installer does - and that guess would fail, loading a blank window. Fixed by bundling the
compiled Angular frontend as a proper resource (`extraResources` in `package.json`) and having `main.ts` find it
via `process.resourcesPath` - Electron's own install-location-independent API - instead. This is why the installer
requires a rebuild (`npm run electron:build`) after this change, rather than working with an older
`dist\win-unpacked\` you might already have lying around.

## Known limitations / not yet verified

- The interactive GUI dialogs (folder/file pickers, message boxes) and the final "does the installed app actually
  show its UI and work correctly" check have not been run end-to-end by an actual person yet - only the
  underlying mechanics (the file copy, the config.json edit, real shortcut creation and readback) have been
  verified directly, using the real project path. Please try a real install and let it be known how it goes.
- No uninstaller script is provided - per the whole point of this being portable, "uninstall" is just deleting
  the folder you installed into (and the shortcut, if you made one). Nothing else was ever written anywhere else.
- This only targets Windows (`WScript.Shell` for the shortcut, `.bat`/`.ps1` for the installer itself) - matching
  the rest of this project, which is Windows-only in practice (ImgBurn, optical media, etc.).
