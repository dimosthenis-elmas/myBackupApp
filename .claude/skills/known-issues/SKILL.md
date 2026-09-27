---
name: known-issues
description: Open issues and known limitations of this app (my-backup, Electron + Angular), sorted by severity, each with how likely it really is, the simplest fix, and where it lives in the code. Use when working on Synchronize directories, Cumulative backup, Backup to optical media, Add missing files, or recovery from optical media; when asked what is left to fix, about known bugs or limitations; or before saying the app is fully correct.
---

# Known issues and limitations

What is still open, and what the app deliberately does not do. When an issue gets fixed, remove it here.

**How to work on these:** suggest the simplest fix first - a clear message or a refusal often beats new machinery.
Add a test only when a regression would really hurt (lost or wrong backup, files touched outside the chosen folders);
very simple fixes need none. Don't over-engineer the fix or the test.

## Open issues

- **High** - can lose data without telling the user.
- **Medium** - a job fails or can't be finished, or the metadata JSON can be lost; the user is told, nothing already
  backed up is lost.
- **Low** - misleading, annoying or slow; nothing is lost.

"Unverified" means read from the code, not reproduced - confirm it first.

### High

None open.

### Medium

#### 1. A file another program has open stops the whole run
- **What happens:** a file locked by another program (an open Outlook `.pst`, a browser's profile) can't be read.
  Cumulative backup and Sync stop at it and leave the rest uncopied; Sync's comparison fails outright; a disc with
  it can't be sent.
- **How likely:** fairly common if such programs are running during a backup. The error names the file, so the
  workaround is easy: close that program and run again.
- **Simplest fix:** in the copy step, skip a file that fails, carry on, and list the skipped files at the end (Sync
  must then not report success).
- **Code:** `insertBranch` / `copyEntryReplacingTarget`, `haveSameContent`, `sha256OfFile` in `app/workers/worker.ts`.

#### 2. Splitting fails when the app's own folder is inside the folder being backed up
- **What happens:** e.g. the app lives on the Desktop and the Desktop is backed up to discs. Split pieces live in the
  app's temp folder, which is then also inside the source, and their paths get trimmed wrongly - every disc with a
  piece fails to send ("plan the discs again", which doesn't help).
- **How likely:** plausible - the app folder is portable and may sit anywhere, the Desktop included.
- **Simplest fix:** refuse a source folder that contains the app's temp folder, saying why (move the app, or choose
  another folder).
- **Code:** the path trimming in `WriteToOpticalMediaProceed` (Backup to optical media) and `sendToImgBurn` (Add
  missing files).

#### 3. The metadata JSON is rewritten in place
- **What happens:** each confirmed disc rewrites the whole JSON; a crash or power cut in that instant leaves it empty
  or cut short. The discs themselves are fine - recovery and Add missing files can read the discs instead.
- **How likely:** very unlikely (a write of a moment).
- **Simplest fix:** write `<name>.tmp` first, then rename it over the JSON. No test needed.
- **Code:** `writeJSONtoDisk` in `app/workers/worker.ts`.

### Low

#### 4. A failed ImgBurn project write is reported as success
- **What happens:** if the `.ibb` file can't be written (the temp folder became unwritable), the disc is still marked
  sent and ImgBurn just doesn't open. Sending the disc again rebuilds it, so the job can go on.
- **How likely:** rare.
- **Simplest fix:** make that failure an error, so the wizard's existing message shows. No test needed.
- **Code:** `createIBB_file` in `app/workers/worker.ts`.

#### 5. A wrongly chosen 7-Zip or ImgBurn is kept for good
- **What happens:** the "not found" dialog saves whatever .exe is picked (7zFM.exe, a portable launcher, the ImgBurn
  setup file): as that file exists, it is never asked again - every split then fails with "plan the discs again",
  and "Send to ImgBurn" starts the wrong program. Only editing config.json gets out of it.
- **How likely:** only where the program is not installed in the usual place (portable copies), but then it sticks.
- **Simplest fix:** the chooser accepts only a file named 7z.exe or ImgBurn.exe, and says so otherwise.
- **Code:** `askWhereExecutableIs` in `app.component.ts`; `locateExecutables` in `app/workers/worker.ts`.

#### 6. Cumulative backup to an exFAT drive may copy everything again on every run (unverified)
- **What happens:** exFAT keeps modified times to 10 ms; Cumulative copies when the source is newer by even 1 ms.
  The result is still correct - just slow.
- **How likely:** exFAT is common on large USB drives, so worth one check: two runs onto an exFAT stick; the second
  must copy nothing.
- **Simplest fix, if confirmed:** allow 2 seconds of difference, as Sync already does (`MIRROR_MTIME_TOLERANCE_MS`).

#### 7. An unreadable folder inside Cumulative backup's backup folder is reported as "NOT backed up"
- **What happens:** the "Some items were left out" warning also lists folders in the backup folder that can't be read,
  as if they were source folders left out.
- **How likely:** rare (a drive root, which always did this, is now refused).
- **Simplest fix:** list only the source's unreadable entries in that warning.
- **Also:** Backup to optical media (its source) and Add missing files (its master) still allow a drive root, which
  also backs up the recycle bin and warns about "System Volume Information" every time. Simplest: refuse it there too,
  like Cumulative backup and Sync.

#### 8. The startup checks run again after every Home
- **What happens:** Home reloads the whole app, so what runs at start runs again: the "leftover items in the temp
  folder" offer comes back, and a 7-Zip or ImgBurn "not found" dialog answered "Not now" is asked again - "Not now"
  lasts only until the next Home.
- **How likely:** certain for anyone without 7-Zip or ImgBurn who only uses Cumulative backup and Sync.
- **Simplest fix:** run the startup checks once per launch - a flag in `sessionStorage` survives the reload.
- **Code:** `ngOnInit` in `app.component.ts`; `goToMainMenuAndReload` in `src/app/shared/utils/go-to-main-menu.ts`.

#### 9. Add missing files is slow on a large collection
- **What happens:** each file of the master is looked for by a search through the whole cold storage list - about 6
  minutes at 100,000 files and an hour at 300,000 (measured). Planning looks up each ticked file in the master the
  same way, without pausing, so the window freezes while many missing files are planned.
- **How likely:** only for large collections.
- **Simplest fix:** look them up in a Map keyed by path.
- **Code:** `diff` and `partition` in `add-missing-files-to-optical-media-cold-storage.component.ts`.

#### 10. Discs read without a JSON are numbered in the order they are inserted
- **What happens:** read one by one ("This disc is now disc 3"), discs get the number of their turn, not the one on
  their label. The JSON Add missing files then writes keeps that order, so a later recovery with it asks for discs by
  numbers that don't match their labels.
- **How likely:** whenever the discs are not inserted in label order.
- **Simplest fix:** ask for them in order ("Insert disc 1") in the reading step.
- **Code:** `readAllDiscsToReconstructTheCompleteBackupFilePaths` in `optical-disc-backup-data-retriever.component.ts`.

#### 11. Small ones
- **A failed Cumulative copy shows two error dialogs** - one `.then(...).catch(...)` chain instead of two handlers in
  `incremental-copying.component.ts`.
- **Cancel during the first count of "Planning discs" is ignored** - the scan resets the stop flag; reset it once, in
  the request handler.
- **Sync: Cancel during the first comparison doesn't stop the second** - check `userCancelledOperation` before the
  second `diff` in `sync-dirs.component.ts`. Nothing is changed on disk.
- **Sync's second comparison shows no progress** - the progress listener is removed when the first request finishes.
- **Some Cancel buttons only hide their dialog** - "Comparing directories" and "Planning discs" in Add missing files,
  and "Preparing ImgBurn project" in both disc wizards: the work goes on. Hide the button there (`showCancelButton =
  false`), as the other steps do.
- **A path containing `%NAME%`** (an environment variable) breaks 7-Zip and the ImgBurn launch, which go through
  `cmd.exe` - use `execFile` instead of `exec`.
- **Backing up an empty folder to discs** ends in "this should never happen" - say "nothing to back up" at planning.
- **Add missing files with nothing ticked** goes on to an empty list of discs and writes an "updated" JSON - say
  "Tick at least one file" in `partition`.
- **A JSON the user dropped is still used** - Add missing files uses a loaded JSON even after "Provide ... JSON" is
  unticked; Recover data, after a good JSON and then a failed pick, still uses the good one. Check the tick box in
  `step1`, and forget the loaded JSON when a pick fails.
- **"No SHA-256 is known ... rather than reading the discs"** (resuming a split file) also shows when the JSON given
  was itself written by an Add missing files run that read the discs, which has no SHA-256 - so the advice can't be
  followed. Reword it: leave this file out (`splitLargeFileIntoPieces` in `app/workers/worker.ts`).
- **A read-only save location for the metadata JSON** leaves a loading dialog open with no message - catch the error.
- **Split pieces get discs of their own** - they never fill the last ordinary disc's free space (e.g. 3 DVDs where 2
  would do). Wasteful, not wrong.
- **The label burned on a disc is cut to 32 characters** - "<collection name> Disc N" loses "Disc N" when the name is
  long. Shorten the name part so " Disc N" always fits; recovery doesn't need the label.
- **A read-only file hard-linked into the backup from outside** loses its read-only mark outside too when it is
  replaced. Only if something else made such hard links.

## Limitations (by design)

- **Nothing is planned or sent beyond a disc's capacity times its maxRepletionRatio** - the rest is a safety margin,
  never spent. Planning (`partitionBackupToOpticalMedia`) counts a split file's pieces at
  what they really take (`plannedPieceSize`: every piece but the last is one volume; the last gets 64 KiB for 7-Zip's
  own records), and each disc's list of original names (`originalNamesEntryBytes` + `ORIGINAL_NAMES_FILE_BASE_BYTES`
  in `disc-names.ts`, once per disc holding a shortened name); a file that fits only without its list is too large for
  a disc. At "Send to ImgBurn" both wizards check what the disc really holds (`discContentBytes` in `optical-media.ts`,
  its list included) and refuse the disc ("Disc too full") when files grew since planning; slivers are accepted, and
  overflow discs filled, by the same measure. Tested in `worker-ipc/test-long-names-on-disc.js` (sections 1, 6, 7).
- **A disc full of very small files may not fit:** discs are planned by file sizes only, but each file also takes
  about 3 KB on a disc. The share kept free covers roughly 16,000 files on a CD, 46,000 on a DVD, 81,000 on a 25 GB
  Blu-ray; a full disc of smaller files than that doesn't fit, and ImgBurn refuses it (estimate, not measured). Only
  backups with tens of thousands of tiny files (source code, mail, thumbnails) meet it; the README says so and
  suggests zipping such folders first. If it ever needs more: count each file as its size rounded up to 2 KB, plus
  3 KB (`partitionBackupToOpticalMedia` in `app/workers/worker.ts`; the README table "How many files fit on one disc").
- **Changed files are replaced safely** (Cumulative backup, Sync, recovery): the new copy is written next to the old
  one under a temporary name (`~my-backup-copy-<hex>.tmp`), then renamed over it - a copy that fails part way leaves
  the old one as it was. Needs room for both until done; a crash leaves the temporary file behind.
- **Sync and Cumulative backup refuse the root of a drive** (`D:\`, source or target): Windows keeps folders there
  the app can't read. Choose a folder on the drive instead. (`checkPathsSelectionIsOk` in `sync-dirs.component.ts`,
  `UpdateBackupProceed` in `incremental-entry-point.component.ts`.)
- **Recovery only copies into an empty folder** - checked at "Next" and again right before copying - so no file
  already there is ever replaced (`recovery-folder.ts`). Tested in `ui/test-recover-single-disc.js`.
- **Recovered files are writable:** on a disc every file is read-only (measured on a real ImgBurn disc), and a copy
  keeps that mark, so recovery clears it (`clearReadOnly` in `createTree`, recovery only). A file that was read-only
  in the folder backed up comes back writable too - the disc cannot tell. Tested in `ui/test-recover-single-disc.js`.
- **FAT / FAT32 are not supported** (stated in the README).
- **Links are never backed up**, by any feature: left out, logged in logs.txt, and counted in a dialog the wizard
  already shows. Sync deletes links in its target (the link itself); Cumulative backup never deletes. A chosen folder
  that is a link, or inside one, is refused (Cumulative, Sync, recovery).
- **Names over 127 characters** (a disc's limit) are listed before planning; only if the user continues are they
  shortened on the disc (start, "~", 8 hex digits, extension). The JSON keeps each `originalPath`, and each such disc
  carries `my-backup original names.json`, so recovery - with or without the JSON - puts the original names back.
  Paths over 259 characters are listed before burning and before recovering. A disc burned before this has names cut
  by ImgBurn itself - recover it by reading the discs, not from the JSON. (`app/workers/disc-names.ts`,
  `src/app/shared/utils/shortened-names.ts`; tested by the three `test-long-names-*` scripts, with real ImgBurn builds.)
- **A large file is split when its disc is sent**, not when the discs are planned. If it changed size enough to need a
  different number of pieces, that disc is refused - plan the discs again.
- **A disc is recorded in the JSON when it is confirmed burned**, with no dialog - also one holding only some pieces
  of a split file. Each piece is named `<file>.outOf.<total>.part.NNN` (`app/workers/split-pieces.ts`), the total
  being the real one - a sliver counted - given right after the split, before any piece reaches a disc. So the app can
  be closed at any time: Add missing files lists a file with pieces missing from the JSON, plans only those pieces,
  and before burning them checks that the new split gives back the pieces already on discs (their SHA-256), refusing
  the disc if the file changed. Needs the JSON - read from the discs, the pieces have no SHA-256, so it refuses. A
  never-confirmed disc stays an empty entry, which recovery, Verify and Add missing files accept; its number is not
  reused (it may have been burned unconfirmed), so new discs are numbered after it (`getNextDiscNumber`). Discs burned before
  the total was added (`<file>.part.NNN`) are taken as complete. Tested in `worker-ipc/test-split-file-resume.js` (a
  sliver included, burned or not) and `ui/test-add-missing-files-split-resume.js`; how a new sliver finds a disc, in
  `ui/test-backup-to-optical-media-overflow-disc.js`.
- **A split file's pieces are ticked together** on every disc, and chosen together in recovery.
- **Add missing files doesn't notice a large (split) file that changed after all its pieces were burned** - accepted
  as a compromise of cold storage. Ordinary files that changed are still caught ("cold storage out of sync"), and so
  is a split file with pieces still missing (by the SHA-256 check above).
- **An empty folder already on a disc counts as backed up** in Add missing files, whatever its modified time now - only
  files are compared by date and size. Tested in `ui/test-add-missing-files.js`.
- **Home stops whatever runs** (a copy, a comparison, waiting for a disc - `goToMainMenuAndReload` sends a stop) and
  reloads the app; a Sync stopped this way may not have deleted everything yet - run it again. A message from before
  the reload is only logged (`sendAndAwaitResponse`). Tested in `ui/test-home-during-copy.js`.
- **Recovery stops with an error** where a name is a file on one disc but a folder on another - only possible when
  two discs of one backup disagree.
- **No Linux build:** paths are joined with `\\`, and ImgBurn is Windows-only.

## Working on these

- `npm run build:prod` before running any test - the tests launch the built app.
- Run affected tests in the real app: `env -u ELECTRON_RUN_AS_NODE node test-harness/<...>.js` (from Git Bash).
- A new test script goes in `test-harness/run-all-tests.bat` (keep its CRLF line endings) and in `docs/TESTING.md`.
- `node test-harness/cleanup.js` clears test scratch data. The disc tests refuse to run while an optical drive has a
  disc in it; the long-names tests need ImgBurn installed.
- `WorkerCommunicator.onDestroy()` removes no listener: Node's `removeAllListeners` clears everything only when called
  with no argument, and the preload bridge always passes one. Harmless - every finished request clears the worker's
  channel, and Home reloads the app. Don't make it a no-argument call: that would also remove the `'app-error'`
  listener that shows the worker's error dialogs.
