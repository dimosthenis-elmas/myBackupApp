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

#### 1. A split file's extra piece can end up on no disc
- **What happens:** now and then 7-Zip makes one more piece than planned (a "sliver"). If sending the disc that would
  take it then fails (hashing, the ImgBurn project), the sliver is dropped from the waiting list and never offered
  again, so the file can't be rejoined on recovery.
- **How likely:** very rare - needs a sliver and a failed send right after it.
- **Simplest fix:** put the slivers back on the waiting list (`pendingOverflowPartials`) when a send fails.
- **Test:** worth one, in `ui/test-backup-to-optical-media-overflow-disc.js`: make that send fail once, retry, and
  check the sliver still reaches a disc.
- **Code:** `sendToImgBurn` in both disc wizards.

#### 2. A retry after a failed 7-Zip split may reuse broken pieces (unverified)
- **What happens:** a large file is only split when no pieces exist yet. If 7-Zip fails part way (e.g. the temp drive
  fills up) and leaves pieces behind, a retry uses them as they are - a short last piece gets burned, and only recovery
  finds the file can't be rejoined.
- **How likely:** rare - needs the temp drive to fill up during a split, and it's unverified whether 7-Zip leaves
  pieces behind.
- **Simplest fix:** when the split command fails, delete the pieces it left before reporting the error.
- **Code:** `createOpticalMediaDiscPartials` in `app/workers/worker.ts`.

### Medium

#### 3. A file another program has open stops the whole run
- **What happens:** a file locked by another program (an open Outlook `.pst`, a browser's profile) can't be read.
  Cumulative backup and Sync stop at it and leave the rest uncopied; Sync's comparison fails outright; a disc with
  it can't be sent.
- **How likely:** fairly common if such programs are running during a backup. The error names the file, so the
  workaround is easy: close that program and run again.
- **Simplest fix:** in the copy step, skip a file that fails, carry on, and list the skipped files at the end (Sync
  must then not report success).
- **Code:** `insertBranch` / `copyEntryReplacingTarget`, `haveSameContent`, `sha256OfFile` in `app/workers/worker.ts`.

#### 4. Splitting fails when the app's own folder is inside the folder being backed up
- **What happens:** e.g. the app lives on the Desktop and the Desktop is backed up to discs. Split pieces live in the
  app's temp folder, which is then also inside the source, and their paths get trimmed wrongly - every disc with a
  piece fails to send ("plan the discs again", which doesn't help).
- **How likely:** plausible - the app folder is portable and may sit anywhere, the Desktop included.
- **Simplest fix:** refuse a source folder that contains the app's temp folder, saying why (move the app, or choose
  another folder).
- **Code:** the path trimming in `WriteToOpticalMediaProceed` (Backup to optical media) and `sendToImgBurn` (Add
  missing files).

#### 5. A disc full of very small files may not fit
- **What happens:** discs are planned by file sizes only, but each file also takes about 3 KB on a disc. The share
  kept free covers roughly 16,000 files on a CD, 46,000 on a DVD, 81,000 on a 25 GB Blu-ray; a full disc of smaller
  files than that doesn't fit and ImgBurn refuses it. (Estimate, not measured.)
- **How likely:** only for backups with tens of thousands of tiny files (source code, mail, thumbnails). The README
  already says so and suggests zipping such folders first - that's the realistic answer for now.
- **Simplest fix, if ever needed:** count each file as its size rounded up to 2 KB, plus 3 KB.
- **Code:** `partitionBackupToOpticalMedia` in `app/workers/worker.ts`; the README table "How many files fit on one
  disc".

#### 6. The metadata JSON is rewritten in place
- **What happens:** each confirmed disc rewrites the whole JSON; a crash or power cut in that instant leaves it empty
  or cut short. The discs themselves are fine - recovery and Add missing files can read the discs instead.
- **How likely:** very unlikely (a write of a moment).
- **Simplest fix:** write `<name>.tmp` first, then rename it over the JSON. No test needed.
- **Code:** `writeJSONtoDisk` in `app/workers/worker.ts`.

### Low

#### 7. A failed ImgBurn project write is reported as success
- **What happens:** if the `.ibb` file can't be written (the temp folder became unwritable), the disc is still marked
  sent and ImgBurn just doesn't open. Sending the disc again rebuilds it, so the job can go on.
- **How likely:** rare.
- **Simplest fix:** make that failure an error, so the wizard's existing message shows. No test needed.
- **Code:** `createIBB_file` in `app/workers/worker.ts`.

#### 8. Cumulative backup to an exFAT drive may copy everything again on every run (unverified)
- **What happens:** exFAT keeps modified times to 10 ms; Cumulative copies when the source is newer by even 1 ms.
  The result is still correct - just slow.
- **How likely:** exFAT is common on large USB drives, so worth one check: two runs onto an exFAT stick; the second
  must copy nothing.
- **Simplest fix, if confirmed:** allow 2 seconds of difference, as Sync already does (`MIRROR_MTIME_TOLERANCE_MS`).

#### 9. An unreadable folder inside Cumulative backup's backup folder is reported as "NOT backed up"
- **What happens:** the "Some items were left out" warning also lists folders in the backup folder that can't be read,
  as if they were source folders left out.
- **How likely:** rare (a drive root, which always did this, is now refused).
- **Simplest fix:** list only the source's unreadable entries in that warning.
- **Also:** Backup to optical media still allows a drive root as its source, which also backs up the recycle bin.
  Simplest: refuse it there too, like Cumulative backup and Sync.

#### 10. Small ones
- **A failed Cumulative copy shows two error dialogs** - one `.then(...).catch(...)` chain instead of two handlers in
  `incremental-copying.component.ts`.
- **Cancel during the first count of "Planning discs" is ignored** - the scan resets the stop flag; reset it once, in
  the request handler.
- **Sync: Cancel during the first comparison doesn't stop the second** - check `userCancelledOperation` before the
  second `diff` in `sync-dirs.component.ts`. Nothing is changed on disk.
- **Sync's second comparison shows no progress** - the progress listener is removed when the first request finishes.
- **A path containing `%NAME%`** (an environment variable) breaks 7-Zip and the ImgBurn launch, which go through
  `cmd.exe` - use `execFile` instead of `exec`.
- **Backing up an empty folder to discs** ends in "this should never happen" - say "nothing to back up" at planning.
- **A read-only save location for the metadata JSON** leaves a loading dialog open with no message - catch the error.
- **Files that grew since planning** are burned without a fit check; ImgBurn then refuses the disc - plan again.
- **Split pieces get discs of their own** - they never fill the last ordinary disc's free space (e.g. 3 DVDs where 2
  would do). Wasteful, not wrong.
- **A read-only file hard-linked into the backup from outside** loses its read-only mark outside too when it is
  replaced. Only if something else made such hard links.

## Limitations (by design)

- **Changed files are replaced safely** (Cumulative backup, Sync, recovery): the new copy is written next to the old
  one under a temporary name (`~my-backup-copy-<hex>.tmp`), then renamed over it - a copy that fails part way leaves
  the old one as it was. Needs room for both until done; a crash leaves the temporary file behind.
- **Sync and Cumulative backup refuse the root of a drive** (`D:\`, source or target): Windows keeps folders there
  the app can't read. Choose a folder on the drive instead. (`checkPathsSelectionIsOk` in `sync-dirs.component.ts`,
  `UpdateBackupProceed` in `incremental-entry-point.component.ts`.)
- **Recovery only copies into an empty folder** - checked at "Next" and again right before copying - so no file
  already there is ever replaced (`recovery-folder.ts`). Tested in `ui/test-recover-single-disc.js`.
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
- **A disc is recorded in the JSON when it is confirmed burned.** Discs sharing a split file are recorded together,
  once all of them are confirmed; until then the app says which discs are still to burn. A never-confirmed disc stays
  an empty entry, which recovery, Verify and Add missing files accept.
- **A split file's pieces are ticked together** on every disc, and chosen together in recovery.
- **Add missing files doesn't notice a large (split) file that changed after it was burned** - accepted as a
  compromise of cold storage. Ordinary files that changed are still caught ("cold storage out of sync").
- **Recovery stops with an error** where a name is a file on one disc but a folder on another - only possible when
  two discs of one backup disagree.
- **No Linux build:** paths are joined with `\\`, and ImgBurn is Windows-only.

## Working on these

- `npm run build:prod` before running any test - the tests launch the built app.
- Run affected tests in the real app: `env -u ELECTRON_RUN_AS_NODE node test-harness/<...>.js` (from Git Bash).
- A new test script goes in `test-harness/run-all-tests.bat` (keep its CRLF line endings) and in `docs/TESTING.md`.
- `node test-harness/cleanup.js` clears test scratch data. The disc tests refuse to run while an optical drive has a
  disc in it; the long-names tests need ImgBurn installed.
