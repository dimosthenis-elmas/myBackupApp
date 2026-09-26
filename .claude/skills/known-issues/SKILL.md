---
name: known-issues
description: Open issues and known limitations of this app (my-backup, Electron + Angular), sorted by severity, with where each lives in the code, how to fix it and how to test it. Use when working on Synchronize directories, Cumulative backup, Backup to optical media, Add missing files, or recovery from optical media; when asked what is left to fix, about known bugs or limitations; or before saying the app is fully correct.
---

# Known issues and limitations

What is still open, and what the app deliberately does not support. When one of the open issues gets fixed, remove it
from this file (and test it if it needs one - see "Working on these" below), and keep the rest in severity order.

## Open issues, by severity

- **High** - can lose data without telling the user: a backup that looks complete but is not.
- **Medium** - a job fails or cannot be finished, or the metadata JSON record can be lost; the user is told, and
  nothing already backed up is lost.
- **Low** - misleading, annoying or wasteful; nothing is lost.

"Unverified" means the cause is read from the code or documentation, not reproduced - confirm it before fixing.

## High

### 1. A split file's leftover piece can be lost when sending a disc fails

- **What happens:** a large file's real split can produce one more piece than planned (a "sliver"). Slivers wait in
  `pendingOverflowPartials` until a disc has room. In `sendToImgBurn`, the list is emptied and the slivers that fit
  are moved onto the disc being sent. If a later step of that send fails (hashing, `create-IBB-file`), the disc is
  not marked sent and the slivers are not put back. On the retry,
  `createOpticalMediaDiscPartials` does not report them again (it only reports a sliver when it performs the split
  itself), so that piece ends up on no disc and the file cannot be reassembled when recovering. The rule that discs
  sharing a split file are recorded together does not catch it: the lost piece is no longer waiting, and on no disc.
- **Rare:** needs a split that produced one piece more than estimated, and a failure after that piece was accepted.
- **Code:** `src/app/backup-to-optical-media/backup-to-optical-media.component.ts` (`sendToImgBurn`,
  `maybeAppendOverflowDiscs`) and the same logic in
  `src/app/add-missing-files-to-optical-media-cold-storage/add-missing-files-to-optical-media-cold-storage.component.ts`.
- **Fix:** only take slivers off `pendingOverflowPartials` once the send has succeeded - put them back on every
  failure path.
- **Test idea:** extend `test-harness/ui/test-backup-to-optical-media-overflow-disc.js` - force a failure after a
  sliver is accepted (e.g. make the hashing fail by locking one of that disc's files with PowerShell,
  `[IO.File]::Open(path, 'Open', 'ReadWrite', 'None')`), then retry and check the sliver still reaches a disc.

### 2. Retrying after a failed split trusts the pieces already there (unverified)

- **What happens:** `createOpticalMediaDiscPartials` only splits a large file when no `<name>.part*` file exists yet
  (`partFileNames.length === 0`); the piece count is only checked right after a fresh split. If 7-Zip fails part way
  (e.g. the temp drive fills up - the temp folder needs the whole file's size free) and leaves pieces behind, every
  retry either fails on a missing piece or burns a cut-short last piece, hashed as it is - so the Verify wizard
  passes, and only recovery finds the file cannot be reassembled. Whether 7-Zip leaves pieces behind on failure is
  not verified.
- **Fix:** when pieces exist, check their count against the plan (`plannedPieceCountsBySession`) and that none is
  missing; otherwise delete them and split again.
- **Test idea:** a stub 7-Zip (like `test-large-file-split-boundary.js` Part 2) that writes one piece and exits 1,
  then the real one; the retry must re-split.

## Medium

### 3. A file another program holds open stops the whole run

- **What happens:** a file opened without sharing (an open Outlook `.pst`, browser profile databases) gives EBUSY on
  copy and on open-for-read (confirmed). Synchronize directories' byte comparison opens every unchanged file on both
  sides, so the comparison fails and nothing can be synced, even when that file did not change. The copy step of both
  Cumulative backup and Sync stops at the first such file, leaving the rest uncopied (the file it stopped at keeps
  its old copy - see copyEntryReplacingTarget). Sync's delete step stops the
  same way at the first target file it cannot delete (`unlinkSync` in `insertBranchForDirSyncDeletions`), leaving the
  sync half done. A disc with such a file cannot be sent (hashing fails).
- **Code:** `haveSameContent` (called from `diff` for `any-difference-or-content`), `createTree`/`insertBranch`,
  `copyEntryReplacingTarget`, `insertBranchForDirSyncDeletions`, `sha256OfFile` - all in
  `app/workers/worker.ts`.
- **Fix:** in the copy step, catch per file, carry on, and list the files that failed at the end (Sync must then
  not report success). In the comparison, count a file that cannot be read as different, so the copy step reports it.
- **Test idea:** in `test-sync-and-cumulative-rules.js`, lock a source file with PowerShell
  (`[IO.File]::Open(path, 'Open', 'ReadWrite', 'None')`) for the length of a run.

### 4. Splitting large files fails when the app's temp folder is inside the folder being backed up

- **What happens:** e.g. the app folder is on the Desktop and the Desktop is backed up. The planned split pieces live
  in the temp folder (`appData\tempFilesCanBeDeleted\session-...`), and the wizard trims the source folder off every
  planned path first, then the temp folder - which no longer matches. A piece's path stays
  `<app folder>\appData\tempFilesCanBeDeleted\session-...\Videos\big.mkv.part.001`, and
  `createOpticalMediaDiscPartials` looks for a large file under that wrong path, so every disc with pieces fails to
  send, with "... is not a file this backup's disc plan splits into pieces ... plan the discs again" - which does not
  help, since a new plan has the same paths. Confirmed with the exact string operations.
- **Code:** `WriteToOpticalMediaProceed` in `backup-to-optical-media.component.ts` (the two `x.path.replace(...)`
  trims); the same order in `add-missing-files-to-optical-media-cold-storage.component.ts`
  (`a.path.replace(this.backup.targetPath, "").replace(tempDataDirectoryPath, "")`).
- **Fix:** trim the temp folder first when a path starts with it, otherwise the source folder - or refuse a source
  folder that contains the temp folder. The app's own files (logs.txt keeps growing after it is hashed) are then in
  the backup too.
- **Test idea:** point `cacheDataDirectoryPath` at a folder inside the source (lib/ibb-tools.js
  `backupAndRedirectConfigField`), plan with splitting, send a disc with pieces (stub 7-Zip), check the .ibb paths.

### 5. Discs holding many small files do not fit (estimate, not measured)

- **What happens:** planning counts only file bytes and keeps a fixed share of each disc free (`maxRepletionRatio` in
  `OPTICAL_MEDIA`). The ImgBurn project builds ISO9660 + UDF 1.02, no Joliet (`FileSystem=3` in
  `appData/IBB_TEMPLATE.ibb`), where every file also takes a 2 KB UDF file entry, its data rounded up to whole 2 KB
  sectors, and two directory records (one per file system) - about 3 KB per file. The free share covers about
  46,000 files on a full DVD (141 MB), 81,000 on a full BD-25 (250 MB) and 16,000 on a full CD (49 MB); a full disc
  whose files average under about 100 KB (DVD), 300 KB (Blu-ray) or 40 KB (CD) does not fit. Planning sorts largest-first, so the smallest files of the whole source end up
  together on the last disc(s): any source with more than one disc's worth of small files (source code, mail,
  thumbnails) gets such discs. ImgBurn then refuses the disc; the app cannot re-plan one disc, and the only way out in
  the app - deselecting files - leaves them out of the backup silently (on no disc, not in the JSON).
- **Code:** `partitionBackupToOpticalMedia` in `app/workers/worker.ts` (both packing loops add `stats.size` only);
  `OPTICAL_MEDIA` in `src/app/shared/utils/optical-media.ts`.
- **Documented:** the README ("Backup to optical media") lists these per-disc file counts as a limit - update or
  remove that table with the fix.
- **Fix:** plan each file as its size rounded up to 2 KB plus a per-file allowance (about 3 KB; a folder, one or two
  blocks), and keep the ratio only for the rest.
- **Test idea:** confirm the per-file cost first with one real ImgBurn build (not the stub) of a folder with many
  small files - ImgBurn builds an image with no prompts from a project file:
  `ImgBurn.exe /MODE BUILD /SRC x.ibb /DEST x.iso /OUTPUTMODE IMAGEFILE /START /CLOSE /NOIMAGEDETAILS /LOG x.log`;
  then a planning check in `test-partitioning.js` that a disc of many tiny files is planned with room for them.

### 6. The metadata JSON is rewritten in place

- **What happens:** `writeJSONtoDisk` (`app/workers/worker.ts`) truncates the file, then writes it. Both disc wizards
  rewrite the whole cold storage metadata JSON each time a disc is confirmed burned; a crash or power loss in between
  leaves it empty or cut short - the record of every disc, which "Recover data from optical media" and "Add missing
  files" read instead of asking for every disc. The discs themselves are fine: both wizards can still read every disc
  instead.
- **Fix:** write `<path>.tmp` next to it, then rename it over the JSON - the same way `copyEntryReplacingTarget`
  replaces a file.
- **Test idea:** a very simple fix - none needed beyond the existing JSON checks in the disc wizards' UI tests.

### 7. A failed ImgBurn project write is reported as success

- **What happens:** in `createIBB_file` (`app/workers/worker.ts`), a failure writing the `.ibb` file is only logged -
  `saveIBB_toDisk(...).catch(err => console.log(err))` - and a refused temp folder only shows an error and returns.
  Either way the `create-IBB-file` request answers "completed", so the wizard marks the disc as sent, although
  ImgBurn never opens. Sending the disc again rebuilds it (no `.ibb` exists to reopen), so the job can go on.
- **Affects:** Backup to optical media and Add missing files (both send discs through `create-IBB-file`).
- **Fix:** let both failures reject (throw) so the wizards' existing `.catch` shows "An error occurred while creating
  the ImgBurn project" and the disc stays unsent, so it can be sent again.
- **Test idea:** in `test-harness/worker-ipc/test-temp-dir-and-imgburn.js`, make the session folder unwritable (a deny
  write ACL) and expect `create-IBB-file` to fail.

## Low

### 8. Cumulative backup to an exFAT drive probably copies most files again on every run (unverified)

- **What happens:** exFAT stores modified times to 10 ms; Cumulative's default comparison copies whenever the source
  is newer by even 1 ms. The README only excludes FAT/FAT32, and exFAT is the default for large USB drives. The result
  is still correct - just slow, and it wears the drive.
- **Fix (if confirmed):** a small modified-time allowance in the default comparison, like Sync's
  `MIRROR_MTIME_TOLERANCE_MS`.
- **Test idea:** a Cumulative run onto an exFAT stick or VHD (needs admin to create), then a second run: it must copy
  nothing.

### 9. Cumulative backup to the root of an NTFS drive warns that the backup drive's own folders are not backed up

- **What happens:** `diff` collects the entries it cannot read from BOTH scans into one `skipped` list and reports it
  as "Some items were left out ... they are NOT backed up". A drive root always holds "System Volume Information",
  which can be stat'ed but not listed (EPERM - confirmed). So a Cumulative backup to the root of an external NTFS drive
  - a common setup - shows that warning on every run, naming a folder on the backup drive, not in the source. An
  unreadable folder anywhere in the backup folder is reported the same misleading way.
- **Also:** a drive root as the SOURCE (Cumulative backup and Backup to optical media allow it) backs up
  `$Recycle.Bin` - the user's own deleted files - since that folder is readable. Whether to leave it out is a product
  decision.
- **Code:** `diff` in `app/workers/worker.ts` (the same `skipped` passed to `getAllFiles` and `getAllFilesSet`),
  `reportSkippedScanEntries`.
- **Fix:** report only the source's skipped entries as "not backed up"; leave the target's out of that warning (or
  word it as "could not be checked in the backup").
- **Test idea:** extend section 3 of `test-harness/ui/test-wizard-error-dialogs.js` (a folder denied listing with
  icacls) with that folder in the backup folder instead of the source: no "NOT backed up" warning may name it.

### 10. A failed Cumulative copy shows two error dialogs

- **What happens:** `ngAfterViewInit` in `src/app/incremental-copying/incremental-copying.component.ts` attaches
  `.catch(onError)` and a separate `.then(...)` to the same `copyingPromise`. When the copy fails (disk full, a locked
  file - issue 3), the promise returned by `.then` rejects with no handler,
  so GlobalErrorHandler adds "Something unexpected went wrong in the app" on top of the "Error" dialog.
- **Fix:** one chain - `.then(...).catch(...)`.
- **Test idea:** in `test-wizard-error-dialogs.js`, make a Cumulative copy fail (delete a source file after the
  comparison, before copying) and check exactly one dialog appears.

### 11. Cancel is ignored while "Planning discs" does its first count

- **What happens:** `getAllFilePathsWithStats` sets `process.env._stop = 'NoStop'` at the start of every call. A
  Cancel that lands during the `countAllFilesQuick` probe before it stops the probe, then the scan resets it and the
  whole plan runs; the "you will need N discs" dialog appears after the user pressed Cancel. The
  `get-file-paths-with-stats` request (Add missing files, recovery) has the same order.
- **Fix:** reset the flag once, in the request handler before the probe, not inside `getAllFilePathsWithStats`.
- **Test idea:** worker-ipc: start a plan of a large generated tree, send `stop` right away (`sendToWorker`), expect
  status "stopped".

### 12. Synchronize directories: Cancel during the first comparison does not stop the second

- **What happens:** the stop reaches the worker before the second `diff` request, which resets the stop flag, so
  the second full scan and `match-letter-case` run in the background after the dialog closed; anything started next
  waits behind them. Nothing is changed on disk.
- **Code:** `syncDirs()` in `src/app/sync-dirs/sync-dirs.component.ts`.
- **Fix:** check `userCancelledOperation` before starting the second `diff` and `match-letter-case`.

### 13. The recovery wizard's "already recovered this disc" fix has no test

- **What it is:** in `src/app/optical-disc-backup-data-retriever/optical-disc-backup-data-retriever.component.ts`,
  the "already recovered this disc" dialog's Retry sets `dialogClosed = true` so `waitForDialog`'s polling loop ends.
  Before, that loop ran forever in the background.
- **Why no test:** the loop has no visible effect, so no UI test can see it. A regression would not be caught.

### 14. Smaller ones

- **A read-only file in the target that is also hard-linked from outside it loses its read-only mark there too:**
  Cumulative backup and Sync replace a changed file by renaming a new copy over it, and Sync deletes by removing the
  name, so the contents outside never change (confirmed with the app's own Electron). But a read-only file has its
  mark cleared first (`chmodSync` in `renameReplacingReadOnlyFile`; `unlinkSync` and `rmSync` do the same), and the
  mark belongs to the file, shared by all its names - so the name outside the target loses it too. Only where
  something else made hard links into the backup. Fix: leave alone a read-only target file with more than one name
  (`lstat`'s `nlink > 1`) and list it in the "Some items were left out" warning.
- **No fit check for a disc's re-measured size:** `sendToImgBurn` only checks slivers against the capacity; files that
  grew since planning are burned even if the disc no longer fits (ImgBurn then refuses it). Planning also counts only
  file bytes - see issue 5 for when the per-medium ratios in `OPTICAL_MEDIA` do not leave enough room for sectors and
  file system records.
- **Split pieces get discs of their own:** `partitionBackupToOpticalMedia` packs ordinary files first and the pieces
  afterwards, so the last ordinary disc's free space is never used for pieces (1 GB of files + one 6 GB file = 3 DVDs
  where 2 would do). Fix: one first-fit-decreasing pass over both.
- **cmd.exe expands `%NAME%` in paths:** the 7-Zip split/test/extract and the ImgBurn launch go through `exec`, so a
  path containing `%NAME%` (NAME an environment variable, e.g. `%USERNAME%`) changes and the step fails. Use
  `execFile`.
- **Backing up an empty folder to optical media:** the plan is one disc holding only the source folder itself, whose
  path trims to "", so its tree is empty and "Send to ImgBurn" says "Disc 1 has no files selected - this should never
  happen" (`sendToImgBurn`). Tell the user there is nothing to back up instead, at planning.
- **A failed first write of the metadata JSON leaves a loading dialog up:** in `proceedToStep2AfterChoosingSavePath`
  (`backup-to-optical-media.component.ts`), `ipc.writeJSONtoDisk` (e.g. a read-only save location) is not caught, so
  the "Building files tree" dialog stays open with no message. Catch it and show the error.
- **Sync's second comparison shows no progress:** `sendAndAwaitResponse` calls `removeAllListeners` when a request
  finishes, which also removes the wizard's progress listener, so the circle stays full during the second `diff`.

## Limitations (by design)

- **Cumulative backup and Sync replace a changed file by copying the new version next to the old one first**, under
  a temporary name (`~my-backup-copy-<8 hex digits>.tmp`), then renaming it over the old file (`copyEntryReplacingTarget`
  in `app/workers/worker.ts`; a read-only old file has its mark cleared, the old file's letter case is kept). A copy
  that fails part way leaves the old copy as it was - tested in `test-sync-and-cumulative-rules.js` section 8. The
  cost: that file needs room on the target drive twice until the copy is complete; and if the app is killed mid-copy,
  the temporary file stays behind (Sync deletes it on its next run, Cumulative backup never deletes anything). Recovery
  from discs copies through the same function.
- **Synchronize directories refuses the root of a drive** (`D:\`, source or target) - `checkPathsSelectionIsOk` in
  `src/app/sync-dirs/sync-dirs.component.ts`. A drive root holds Windows' own folders ("System Volume Information",
  other users' `$Recycle.Bin`) that cannot be listed, and Sync deliberately does not skip unreadable entries. A volume
  mounted into a folder is not recognized as a drive root.
- **FAT file systems (FAT, FAT32) are not supported** - stated in the README. Sync still allows 2 seconds of
  difference in modified times (`MIRROR_MTIME_TOLERANCE_MS`).
- **A large file is split when its disc is sent, not when the discs are planned** - possibly hours later in the same
  session. If its size has changed enough since planning to need a different number of 500 MiB pieces, sending the
  first disc with one of its pieces is refused ("... has changed since the discs were planned ... plan the discs
  again", `createOpticalMediaDiscPartials` against `plannedPieceCountsBySession`, both in `app/workers/worker.ts`) and
  nothing is split - otherwise the pieces the plan does not have would be on no disc. Tested in
  `test-large-file-split-boundary.js` Part 3.
- **A disc is recorded in the cold storage metadata JSON when it is confirmed burned, not when it is sent** - both
  disc wizards (`recordConfirmedDiscs`). Discs holding pieces of the same large file - planned pieces or a sliver,
  following every split file on a disc, through other discs too (`linkedDiscGroup` in
  `src/app/shared/utils/linked-discs.ts`) - are recorded together, only once all of them are confirmed and no piece of
  their files is still waiting for a disc. Confirming one of them before that shows an "Also burn disc ..." notice:
  if the app is closed now, the discs already burned are not in the JSON and will be re-planned ("Add missing files"
  puts their files on new discs), so the user should note them down. Reason: a split file can only be put back
  together from all of its pieces, and "Add missing files" counts a file as backed up as soon as the JSON has any one
  of its pieces (`replacePartialFileSplits`). Tested in `ui/test-backup-to-optical-media-overflow-disc.js`. A disc
  never confirmed stays an empty entry, however many there are: recovery from the JSON and the Verify wizard leave
  empty discs out of their "two discs with the same id" check (all empty discs share one id) - tested with two empty
  discs in `ui/test-recover-from-json-metadata.js` and `ui/test-verify-cold-storage-integrity.js` - and "Add missing
  files" also takes a JSON with no disc recorded at all.
- **A split file's pieces are ticked together, on every disc** (Backup to optical media, `onDiscSelectionChange`):
  ticking or unticking one piece - or a folder, or "Select all" - does the same to all of that file's pieces on every
  disc, since a file can only be put back together from all of them; once a disc holding one of its pieces has been
  sent (or is being sent), a change that disagrees with it is refused with a message and set back. Recovery always
  selects a file's pieces together too (`groupPartialFiles`; the old "Group partials" checkbox is gone). Tested in
  `ui/test-backup-to-optical-media.js`.
- **Links are never backed up, by any feature:** each scan leaves them out (`leaveOutLink` in `app/workers/worker.ts`
  - from `getAllFilePathsWithStats` for discs, from `diff` for Cumulative backup and Sync) and writes each one, with
  where it points, to logs.txt only; the request's response counts them (`linksLeftOut` on `WorkerResponse`), and
  every backup wizard says how many, if any, in a dialog it already shows before copying or burning
  (`withLinksLeftOutNote` in `src/app/shared/utils/links-note.ts`) - the "Some items were left out" warning would
  otherwise name Windows' own links ("My Music" in Documents, ...) on every run. A link the user made (a folder moved
  elsewhere, with a junction left in its place) is therefore only a number in that dialog and a line in logs.txt -
  what it points to is not in the backup. What a link points to is not backed up through it, and no link is ever put into a backup, so nothing in one
  leads outside it. Sync deletes the target's links (the link itself - `diff`'s `listLinks` on its delete list);
  Cumulative backup never deletes, so a link already in a backup stays. A folder holding only links counts as empty.
  Tested in `worker-ipc/test-scan-edge-cases.js` (discs) and `worker-ipc/test-sync-and-cumulative-rules.js` section 3.
- **Cumulative backup, Sync and recovery refuse a chosen folder that is a link, or inside one**
  (`refuseLinkedFolder`, called by `diff` and `createTree`): they would otherwise work in, and Sync delete in,
  wherever it leads. Each folder on the path is checked with `lstat`, so a SUBST drive or a mapped network drive is
  not taken for a link. Recovery only finds out when it starts copying from the first disc (it has no comparison
  step). Tested in `test-sync-and-cumulative-rules.js` section 4b.
- **Recovery** stops with an error on a name that is a file in the recovery folder but a folder on the disc (or the
  other way round) - it passes no `NameClash`.
- **A Linux build is not ready:** the sync and copy code joins paths with `\\` throughout (`diff`, `createTree`,
  `deleteFilesAndDirsForDirSync`); `fs.copyFileSync` on Linux does not keep modified times, which Sync's comparison
  relies on (add `fs.utimesSync` after copying); ImgBurn is Windows-only.

## Working on these

- Run `npm run build:prod` before running any test - the tests launch the compiled `app/*.js` and `dist/`.
- Run the affected test-harness scripts in the real app: `env -u ELECTRON_RUN_AS_NODE node test-harness/<...>.js`
  (from Git Bash in an agent shell). A plain-Node stand-in has missed real failures: the app runs Electron's own Node
  from a folder whose name has Greek letters, and both matter.
- Test a fix when a regression would really bite (data deleted or written outside the chosen folders, a wrong
  backup, a crash in a common path), and check the test fails without the fix. Very simple fixes need no test of
  their own; keep tests lean, preferring a section in an existing script. Every test script is listed in
  `test-harness/run-all-tests.bat` (keep that file's line endings CRLF) and in `docs/TESTING.md` - add a new one to
  both.
- Clean up after testing: `node test-harness/cleanup.js` empties `test-harness/generated-fixtures/` and the app's temp
  folder (keeping its ownership marker); `run-all-tests.bat` does this itself when everything passes.
- The capture scripts (`ui/capture-readme-screenshots.js`, `ui/capture-recover-data-gif.js`) and the ISO-based tests
  refuse to run while any optical drive has a disc in it - eject it first. They overwrite `docs/screenshots/` and
  `docs/media/`.
