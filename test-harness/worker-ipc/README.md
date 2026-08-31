# Worker IPC tests (split/merge, without clicking through the UI)

New to this test harness? Read `test-harness/README.md`'s "How it all fits together" and "Your first run, step
by step" sections first - everything below assumes you already know the big picture.

This tests the app's file-splitting/merging logic directly — skipping the on-screen buttons entirely — by
talking to the app's own internal "engine" the same way the visible screen does.

## The idea, explained simply

This app is actually built from *two* programs running together behind the scenes: the window you see and
click on (called the "renderer"), and a hidden "worker" that does the real file-handling work (splitting large
files, merging them back together, figuring out which files go on which disc). When you click a button on
screen, what really happens is: the visible window sends a small message to the hidden worker saying "please do
this," waits, and gets a message back saying "done" (or "here's what went wrong"). This message-passing is
called IPC ("Inter-Process Communication").

These scripts send those exact same messages directly — using the exact same message format the real app
already uses — instead of clicking a button and waiting for the screen to do it for you. That means:
- It's testing the *real* file-handling code, not a simplified stand-in for it.
- It's much faster than clicking through several screens by hand.
- **No app code is changed to make this possible** — it launches the real, already-built app and talks to it
  exactly the way its own screen does, just from a script instead of a mouse click.

## ⚠️ This needs a real screen/desktop to run

Electron apps (like this one) need an actual Windows desktop session to open a window into — they can't run
"headless" (with no screen at all) the way some other kinds of automated tests can. If this fails silently in
some kind of remote/automated environment with no real screen, that's why — not a bug in the app or the script.
Run it from your own normal desktop.

**Every script here prints a before/after directory tree** of whatever folders matter for it, via the shared
`../lib/print-tree.js` (an indented listing of every file with its size, empty directories marked as such) - for
visual inspection only; the real pass/fail authority is still each script's own byte-for-byte check.

## What's here

### `test-partitioning.js` — fast, and checked to be safe first
```
node test-harness/worker-ipc/test-partitioning.js
```
Makes a small random test folder, then asks the app's engine "if I had to spread these files across discs of
this size, how would you divide them up?" — and checks the answer is actually correct (every file placed
exactly once, no disc over its size limit).

This one is quick because it never actually splits any large files (that only happens for a file bigger than
one disc) — but the app still does a quick safety check on its own temp/working folder every time it's asked
this question, regardless, so this script double-checks that folder is currently empty (aside from the app's own
marker showing it created it) before doing anything, the same way `test-merge.js` below does.

### `test-merge.js` — actually touches the app's real temp folder (double-checked first)
```
node test-harness/worker-ipc/test-merge.js
```
Makes a small test file, splits it into several pieces using the same tool (7-Zip) and the same settings the app
itself uses — just with a much smaller piece size, so a tiny 50KB test file produces several real pieces instead
of needing a 500-megabyte file — then asks the app's engine to merge those pieces back together, and checks the
result matches the original file exactly (by fingerprint).

This one really does write into the app's actual, real temp/working folder (there's no separate "test" version
of that folder — the app always uses the one real one). So, before doing anything, it checks that folder is
currently empty first (aside from the app's own marker proving it created that folder itself) and refuses to run
if it isn't — see "Why check the temp folder" below. It also cleans up everything it created there, whether it
passes or fails.

### Why check the temp folder first?
That folder is named `tempFilesCanBeDeleted` by the app's own design — everything in it is meant to be
throwaway, regenerable from your original files. So the real risk isn't "losing" anything precious; it's
*timing*: if you happen to be in the middle of a real multi-disc backup — burned disc 1 already, but discs 2–5's
split pieces are still sitting in that folder waiting to be burned — running this test at that exact moment
could disturb those pending pieces before you've burned them. Not permanent data loss (you could always redo
the split from your original files), just an avoidable annoyance. The check makes sure that scenario can't
happen silently.

### `test-incremental-backup.js` — the cumulative/incremental backup flow (diff + copy), no disc involved at all
```
node test-harness/worker-ipc/test-incremental-backup.js
```
Tests the "Cumulative (incremental) backup" screen's real logic — `diff` (figure out what's new/changed) and
`incremental-copy-files` (actually copy it) — purely folder-to-folder. Unlike the two scripts above, this never
touches optical media simulation or the app's shared temp/cache directory, so there's no temp-dir-guard check
needed here.

What it actually proves, in order: (1) a first sync from an empty target copies every source file across,
byte-for-byte; (2) after modifying 2 source files and adding 1 new one, `diff` reports **exactly** those 3
changed paths, not the whole tree again — asserted as an exact set match, which is what actually distinguishes
"real incremental diffing" from "copies everything and happens to get the right answer"; (3) a second copy call
correctly updates just those 3 files, and — checked by comparing every target file's modified-time before/after —
never re-touches any of the untouched files (re-copying everything would still pass the hash check in step 2, so
only an mtime comparison actually catches that).

One wrinkle worth knowing: `diff` correctly reports `generate-random-tree.js`'s own ownership-marker file
(`.optical-backup-test-fixture.json`) as "source-only" too — it genuinely is a real file sitting in the source
root, so that's the diff logic working correctly, not a flaw. `verify-manifest.js` and this test both exclude
that marker from their own directory listings for the same reason.

### `test-sync-dirs.js` — the Synchronize directories flow (diff both ways + copy + DELETE)
```
node test-harness/worker-ipc/test-sync-dirs.js
```
Tests the "Synchronize directories" screen's real logic — reproducing the exact algorithm
`sync-dirs.component.ts` uses: `copyPaths = diff(source, target)`, `deletePaths = diff(target, source)` minus
anything already in `copyPaths` (modified files are handled by copy, never delete+recreate), then copy, then
delete. **This is the one script here that can genuinely delete real files** (everything else in `worker-ipc/`
only reads/copies), so it's worth reading its own header comment in full before touching it — in short: preview
mode (`commit=false`) always runs first with an explicit on-disk assertion that nothing was deleted, the files it
lets get deleted are a small hand-picked set it plants itself (never anything computed/sweeping), and a path
guard fires immediately before the one real delete call.

**A naming trap worth knowing about, current app behavior (not a bug):**
`WorkerCommunicator.deleteFilesAndDirsForDirSync`'s parameter is named `previewOnly` and sent over IPC that way,
but `worker.ts`'s handler passes it straight through, unchanged, into the worker function's own parameter —
which is actually named `commit`. There's no inversion applied anywhere. So `previewOnly: true` actually
**commits** deletions, and `previewOnly: false` actually **previews only** — backwards from what the name
suggests. The app itself only gets this right today because both real call sites in `sync-dirs.component.ts`
pass the value they mean for `commit`, with an inline comment overriding the misleading parameter name.
`test-sync-dirs.js` names its own constants after what they actually do, never passes a bare `true`/`false` to
this call, and documents this in full in its header comment. Worth remembering if you ever touch this call site.

Proven: copy-side and delete-side path sets both match exactly what's expected, preview mode provably deletes
nothing, the real commit correctly deletes a planted leftover file AND cleans up the now-empty directory it was
in, and the final target matches a freshly rebuilt manifest with zero `EXTRA` entries (i.e. `verify-manifest.js`'s
own independent directory listing confirms the leftovers are really gone, not just the two paths this script
expected).

### `test-large-file-split.js` — the REAL "split a too-large-for-any-disc file" path, at real scale
```
node test-harness/worker-ipc/test-large-file-split.js
```
Generates a real 700 MB file and lets the app's own code do the real split (`partition-backup-to-optical-media`
with `splitLargeFiles: true` - the actual `7z -v500m -mx0 a ...` call in `worker.ts`, not a smaller stand-in),
then feeds the real resulting part files into the already-proven `merge-file-parts` to confirm the whole round
trip is byte-for-byte correct at the real 500 MiB volume size, not just at `test-merge.js`'s smaller scale.
Every check passes, including a direct sha256 comparison between the original 700 MB file (hashed while it was
written) and the reassembled file, byte-for-byte identical.

The pass that assigns ordinary files to "discs" has always explicitly detected "this one file alone is bigger
than any single disc" and stopped; the *second* pass — the one that assigns each real SPLIT PIECE to a disc — now
has the identical guard (see `test-split-piece-capacity-guard.js` below for the regression test proving it).
**Not reachable through the real app UI** either way - the smallest real medium you can select (a 700MB CD) is
always bigger than a 500 MiB piece, which is exactly why that constant's own comment says it was chosen to
comfortably fit the smallest medium - but it *is* reachable by calling `partitionBackupToOpticalMedia` directly
with too small a capacity. `MEDIA_CAPACITY_BYTES` in this script is chosen to stay comfortably clear of it
regardless - see that constant's own comment for the exact math.

Two things worth knowing if you extend this script: `-v500m -mx0` still wraps the data in a real 7z *archive*
(headers/CRC/filename metadata), so the total archived size is always a little bigger than the original file
(not identical) - check the first volume's size exactly (7-Zip only ever truncates the *last* volume) and the
total against a small overhead margin instead of an exact byte count. And `mergeFileParts` writes the reassembled
file next to the part files it was given, mirroring the large file's original relative subdirectory - not the
temp directory's own root.

### `test-split-piece-capacity-guard.js` — proves the split-piece infinite loop is actually fixed
```
node test-harness/worker-ipc/test-split-piece-capacity-guard.js
```
Regression test for the bug described above: calls `partition-backup-to-optical-media` directly with
`splitLargeFiles: true` and a `mediaCapacityInBytes` deliberately smaller than the one real split piece a 20 MB
source file produces - the exact condition that used to spin forever. Uses a real (short - 60s, not the usual
5-minute default) `callWorker` timeout, so if this ever regresses, the test FAILS promptly with a clear message
instead of hanging. Confirms the call now rejects with `err_code: 'FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC'` -
the exact same rejection shape the ordinary-file pass has always produced for this situation - instead of never
returning at all.
