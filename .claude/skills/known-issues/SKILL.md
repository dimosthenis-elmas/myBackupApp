---
name: known-issues
description: Open issues and known limitations of this app (my-backup, Electron + Angular), with where each lives in the code, how to fix it and how to test it. Use when working on Synchronize directories, Cumulative backup, Backup to optical media, Add missing files, or recovery from optical media; when asked what is left to fix, about known bugs or limitations; or before saying the app is fully correct.
---

# Known issues and limitations

What is still open, and what the app deliberately does not support. When one of the open issues gets fixed, add a
test for it (see "Working on these" below) and remove it from this file.

## Open issues

### 1. A failed ImgBurn project write is reported as success

- **What happens:** in `createIBB_file` (`app/workers/worker.ts`), a failure writing the `.ibb` file is only logged -
  `saveIBB_toDisk(...).catch(err => console.log(err))` - and a refused temp folder only shows an error and returns.
  Either way the `create-IBB-file` request answers "completed", so the wizard marks the disc as sent, although
  ImgBurn never opens.
- **Affects:** Backup to optical media and Add missing files (both send discs through `create-IBB-file`).
- **Fix:** let both failures reject (throw) so the wizards' existing `.catch` shows "An error occurred while creating
  the ImgBurn project" and the disc stays unsent, so it can be sent again.
- **Test idea:** in `test-harness/worker-ipc/test-temp-dir-and-imgburn.js`, make the session folder unwritable (a deny
  write ACL) and expect `create-IBB-file` to fail.

### 2. A split file's leftover piece can be lost when sending a disc fails

- **What happens:** a large file's real split can produce one more piece than planned (a "sliver"). Slivers wait in
  `pendingOverflowPartials` until a disc has room. In `sendToImgBurn`, the list is emptied and the slivers that fit
  are moved onto the disc being sent. If a later step of that send fails (hashing, writing the metadata JSON,
  `create-IBB-file`), the disc is not marked sent and the slivers are not put back. On the retry,
  `createOpticalMediaDiscPartials` does not report them again (it only reports a sliver when it performs the split
  itself), so that piece ends up on no disc and the file cannot be reassembled when recovering.
- **Rare:** needs a split that produced one piece more than estimated, and a failure after that piece was accepted.
- **Code:** `src/app/backup-to-optical-media/backup-to-optical-media.component.ts` (`sendToImgBurn`,
  `maybeAppendOverflowDiscs`) and the same logic in
  `src/app/add-missing-files-to-optical-media-cold-storage/add-missing-files-to-optical-media-cold-storage.component.ts`.
- **Fix:** only take slivers off `pendingOverflowPartials` once the send has succeeded - put them back on every
  failure path.
- **Test idea:** extend `test-harness/ui/test-backup-to-optical-media-overflow-disc.js` - force a failure after a
  sliver is accepted (e.g. make the metadata JSON unwritable), then retry and check the sliver still reaches a disc.

### 3. The recovery wizard's "already recovered this disc" fix has no test

- **What it is:** in `src/app/optical-disc-backup-data-retriever/optical-disc-backup-data-retriever.component.ts`,
  the "already recovered this disc" dialog's Retry sets `dialogClosed = true` so `waitForDialog`'s polling loop ends.
  Before, that loop ran forever in the background.
- **Why no test:** the loop has no visible effect, so no UI test can see it. A regression would not be caught.

## Limitations (by design)

- **FAT file systems (FAT, FAT32) are not supported** - stated in the README. Sync still allows 2 seconds of
  difference in modified times (`MIRROR_MTIME_TOLERANCE_MS`).
- **Symbolic links other than junctions** can only be recreated by Cumulative backup and Sync with administrator
  rights or Developer Mode on; otherwise the copy stops with a clear message. A link that points to nothing, given by
  a full path, is recreated as a junction.
- **Links on discs** are burned as Windows shortcuts (`<name>.lnk`, created with PowerShell and `IShellLinkW`);
  recovery restores the shortcut file, not a real link. A link whose shortcut name is already taken by a real file is
  left out and listed in the "Some items were left out" warning.
- **Recovery** stops with an error on a name that is a file in the recovery folder but a folder on the disc (or the
  other way round) - it passes no `NameClash`.
- **A Linux build is not ready:** the sync and copy code joins paths with `\\` throughout (`diff`, `createTree`,
  `deleteFilesAndDirsForDirSync`); `fs.copyFileSync` on Linux does not keep modified times, which Sync's comparison
  relies on (add `fs.utimesSync` after copying); ImgBurn and the disc shortcuts are Windows-only.

## Working on these

- Run `npm run build:prod` before running any test - the tests launch the compiled `app/*.js` and `dist/`.
- Run the affected test-harness scripts in the real app: `env -u ELECTRON_RUN_AS_NODE node test-harness/<...>.js`
  (from Git Bash in an agent shell). A plain-Node stand-in has missed real failures: the app runs Electron's own Node
  from a folder whose name has Greek letters, and both matter.
- Every fix gets a test under `test-harness/` that is listed in `test-harness/run-all-tests.bat` (keep that file's
  line endings CRLF) and in `docs/TESTING.md`.
