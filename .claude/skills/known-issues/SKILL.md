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

None open.

### Low

#### 1. An unreadable folder inside Cumulative backup's backup folder is reported as "NOT backed up"
- **What happens:** the "Some items were left out" warning also lists folders in the backup folder that can't be read,
  as if they were source folders left out.
- **How likely:** rare (a drive root, which always did this, is now refused).
- **Simplest fix:** list only the source's unreadable entries in that warning.
- **Also:** Backup to optical media (its source) and Add missing files (its master) still allow a drive root, which
  also backs up the recycle bin and warns about "System Volume Information" every time. Simplest: refuse it there too,
  like Cumulative backup and Sync.

#### 2. The startup checks run again after every Home
- **What happens:** Home reloads the whole app, so what runs at start runs again: the "leftover items in the temp
  folder" offer comes back, and a 7-Zip or ImgBurn "not found" dialog answered "Not now" is asked again - "Not now"
  lasts only until the next Home.
- **How likely:** certain for anyone without 7-Zip or ImgBurn who only uses Cumulative backup and Sync.
- **Simplest fix:** run the startup checks once per launch - a flag in `sessionStorage` survives the reload.
- **Code:** `ngOnInit` in `app.component.ts`; `goToMainMenuAndReload` in `src/app/shared/utils/go-to-main-menu.ts`.

#### 3. Small ones
- **A failed Cumulative copy shows two error dialogs** - one `.then(...).catch(...)` chain instead of two handlers in
  `incremental-copying.component.ts`.
- **A JSON the user dropped is still used** - Add missing files uses a loaded JSON even after "Provide ... JSON" is
  unticked; Recover data, after a good JSON and then a failed pick, still uses the good one. Check the tick box in
  `step1`, and forget the loaded JSON when a pick fails.
- **A read-only save location for the metadata JSON** leaves a loading dialog open with no message - catch the error.
- **A file locked by another program still stops a disc from being sent** (optical backup): unlike Cumulative backup
  and Sync, whose copy step now skips and lists such files, a disc cannot be burned without a SHA-256 hash for every
  file, so a file locked during hashing fails that disc's send with a clear error. Close the program and send again.
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
- **Only NTFS is supported** - not FAT, FAT32 or exFAT (stated in the README).
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
  never-confirmed disc stays an empty entry, which recovery, Verify and Add missing files accept. Discs are sent (and
  so confirmed) in order (`mayBurnDisc` in `shared/utils/optical-media.ts`), so the empty entries are all at the end;
  Add missing files drops them (`step1`), so new discs take their numbers (`getNextDiscNumber`) - a disc burned but
  never confirmed then shares its number with a new one. An empty entry before a confirmed disc (a JSON from before
  discs were burned in order) stays, so that disc keeps its number. Discs burned before
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
- So a progress listener (`ipc.onResponseFromWorker`) lasts only until the next request finishes: register it again
  for each request it should follow, as Sync's two comparisons do.
- A pause that lets the window redraw (`setTimeout(0)`) takes about 6 ms here: in a long loop, pause about every 50 ms
  (`yieldIfDue` in `files-tree.component.ts`, `diff` in Add missing files), never every few items - pausing every 25
  files made a 100,000-file tree take 21 s instead of 0.3 s.
- 7-Zip and ImgBurn are started through `cmd.exe` with their paths in environment variables (`execWithPaths` in
  `app/workers/worker.ts`): `cmd.exe` expands only once, so a `%NAME%` in a path stays as it is (tested by
  `worker-ipc/test-merge.js`). Not `execFile`: the tests stand the programs in with `.bat` files, which `execFile`
  cannot start from a folder with spaces (the repository's own) - and Node 20.12.2 and later refuse outright.
