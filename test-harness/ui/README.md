# UI click-through tests

New to this test harness? Read `test-harness/README.md`'s "How it all fits together" and "Your first run, step
by step" sections first - everything below assumes you already know the big picture.

This is the piece that most directly solves the original problem: it makes a robot click through real app
screens for you — no physical disc, no manual clicking.

Seven test scripts live here - one for every one of the app's 5 main-menu features (two of them get two scripts
each, for a second entry point or a second disc count) - plus one non-test utility script
(`capture-readme-screenshots.js`, documented in its own section below) that reuses the same real-app-driving
machinery to grab screenshots for the top-level README instead of verifying anything:
- `test-recover-single-disc.js` — the "Recover data from optical media backup" wizard (needs a simulated disc).
- `test-incremental-backup.js` — the "Cumulative backup" wizard (pure folder-to-folder, no disc involved).
- `test-sync-dirs.js` — the "Synchronize directories" wizard (copies AND deletes - see its own section below).
- `test-recover-multi-disc.js` — the recovery wizard across TWO discs (extends the single-disc one).
- `test-recover-from-json-metadata.js` — the recovery wizard's OTHER entry point: seeding the disc listing from a
  provided cold storage metadata JSON file instead of physically reading every disc.
- `test-backup-to-optical-media.js` — the "Backup to optical media" wizard, up to and including "Send to ImgBurn"
  (with the real ImgBurn launch safely redirected to a no-op stub - see its own section below).
- `test-add-missing-files.js` — the "Add missing files to optical media cold storage" wizard - see its own
  section below.

**All seven pause 5 seconds after every click** (`WATCH_PAUSE_MS` near the top of each script's `step()` helper) -
purely so you can actually watch each step land on screen as it runs, not because the app needs it. Lower it (or
remove the `await new Promise(...)` line) if you'd rather they run at full speed.

**All seven (and every `worker-ipc/` script too) print a before/after directory tree** of whatever folders matter
for that test, via the shared `lib/print-tree.js` (an indented listing of every file with its size, empty
directories marked as such) - so you can actually see what went where, not just a pass/fail summary. This is
purely for visual inspection; the real pass/fail authority is still whatever byte-for-byte check (usually
`verify-manifest.js`) each script already runs.

An interrupted run deliberately leaves its scratch data in place for inspection instead of cleaning up - see each
script's own cleanup notes. Run `node test-harness/cleanup.js` (or `--dry-run` to just see what it would remove)
to clear it all out - see the top-level README's own section on it.

## Switching between random and JSON-driven source trees

Every one of the seven scripts builds its own "master"/"source" tree the same way: step 1 of each script's `main()`
calls the shared `generateFixtureTree()` helper (`../lib/fixture-tree-source.js`), which understands the same
flag on **every** script here:

- `--random-tree` — generate a random tree (`generate-random-tree.js`). This is the **default** - running any
  script with no flags at all behaves exactly as it always has.
- `--json-tree` — generate from this script's own bundled spec instead, at
  `test-harness/ui/tree-specs/<script-name>/tree-spec.json`, via `generate-tree-from-json.js`.

```
node test-harness/ui/test-recover-single-disc.js               # random (default, unchanged)
node test-harness/ui/test-recover-single-disc.js --json-tree   # this script's own bundled tree-spec.json
```

**Why bother with JSON specs when random mode already works?** They're not strictly required - every script
runs fine with no flags at all - but they earn their keep as *readable, self-documenting reference fixtures*,
which random mode can't be. Random mode's own inputs are just CLI flags
(`--files 20 --max-depth 4 --seed 224466 --large-file-bytes 700000000`) - to know what tree that actually
produces, you have to run it and look. A `tree-spec.json` *is* the tree, in plain text, readable without running
anything - exactly the kind of thing worth having a year from now when you don't want to reconstruct a fixture's
shape from memory or a re-run.

There's no separate flag to point at some other file - `tree-spec.json` is a real, plain JSON file meant to be
**edited in place** for your own scenarios: open
`test-harness/ui/tree-specs/test-recover-single-disc/tree-spec.json` (or whichever script you're working with),
change the paths/sizes/entries to whatever you want, save it, and `--json-tree` picks up your edit on the next
run - no path to pass, nothing else to configure.

**Each script ships its own spec** under `test-harness/ui/tree-specs/<script-name>/` rather than sharing one
generic tree, because several scripts' downstream assertions depend on specific things being true of the
generated tree - not just "some files exist":
- `test-recover-multi-disc.js`, `test-recover-from-json-metadata.js`, `test-backup-to-optical-media.js`, and
  `test-add-missing-files.js` all split/verify a large file whose size has to match their own `LARGE_FILE_BYTES`
  constant (700,000,000 bytes) exactly, so the resulting real 7-Zip split produces the exact piece count/sizes
  those scripts assert on - the bundled `tree-spec.json` for each declares its large file at that exact size,
  under `large-files/oversized-file.bin` (the same relative path/name `generate-random-tree.js --large-file-bytes`
  itself always uses, and - for `test-backup-to-optical-media.js` specifically - a path that script locates by a
  hardcoded join, not via the manifest). If you edit one of these four in place, keep the large file's declared
  size and path matching what that script's own constants expect (see each script's own header comment) - a
  same-shaped but differently-sized tree will still generate fine, but that script's structural assertions
  (exact piece count, exact disc count) will fail against it, since those numbers are derived from the real
  700MB/500MiB arithmetic, not discovered at runtime.
- `test-incremental-backup.js` and `test-sync-dirs.js` deliberately have NO large file and NO edge cases in
  their specs (matching their own `--no-edge-cases` random-mode flag) - their own scope is the wizard's
  screens, not edge-case coverage.
- `test-backup-to-optical-media.js` and `test-add-missing-files.js` do NOT ship a `split-plan.json` - the large
  file has to arrive whole, because the real thing each of those two tests exists to prove is that **the app
  itself** correctly splits it live (`splitLargeFiles: true`). Pre-splitting it would skip that entirely.
- `test-recover-multi-disc.js` and `test-recover-from-json-metadata.js` are the opposite: they DO ship a
  `split-plan.json` (same large file, same 500 MiB volume size). What those two exist to prove is the
  **recovery wizard's own "reassemble these `.part.NNN` files?" merge flow** - not that the app can split a
  file live, which is already proven by the two scripts above (and by `worker-ipc/test-large-file-split.js`).
  So both scripts check whether the pieces already exist on disk right after generation (the whole file is
  simply absent) and, if so, skip the live `partition-backup-to-optical-media` IPC call entirely and just
  distribute the already-made pieces across the two discs. This also means editing either of these two specs
  to use a *different* large file only requires updating `tree-spec.json`'s size and `split-plan.json`'s
  `volumeSizeMiB` together (both scripts still expect exactly 2 pieces out of it - see the size math in each
  script's own header comment).

## `test-recover-single-disc.js`

## The idea, explained simply

**Playwright** is a tool that can operate an app the way a person would: it opens the real app, "reads" what's
currently on screen, clicks buttons, types into fields, and can even take a screenshot of what it's looking at —
like a very fast, very literal robot sitting at your keyboard. It's the same underlying tool this project
already used for a much simpler existing check (`e2e/main.spec.ts`, which just confirms the app opens); this
script uses it to click all the way through an actual real task instead.

Since a real "insert a disc" moment needs an actual disc, this test uses a mounted `.iso` file instead (see
`test-harness/optical-media`) — Windows can't tell the difference, so the app genuinely can't either.

One more trick: when you click "choose a folder to save to," the app normally pops up Windows' own folder-picker
window and waits for you to click something in it. A script can't click a window that isn't part of the app's
own screen — so this test tells the app, in advance, "when you'd normally show that picker, just act as if the
user already chose *this* folder" (a folder the test itself created for exactly this purpose). This is safe
because we're the ones deciding what that folder is, and it's always a throwaway test folder, never anything
real of yours.

## ⚠️ Before running: check what's in your optical drive(s)

This test refuses to even start if Windows currently reports *any* optical drive with a real disc, or someone
else's mounted `.iso`, already in it — using the exact same check the app itself uses to decide "is there a disc
in the drive." (An empty drive letter with nothing in it is fine — only *actual loaded media* stops it.) If you
see:

```
Refusing to run: Windows already reports an optical drive with media loaded ({"DeviceID":"D:", ...})
```

eject whatever real disc is there, or run `Dismount-DiskImage -ImagePath <whatever's mounted>` if it's someone
else's `.iso`, then try again.

## Scope: one disc, recovery only (for now)

The separate "back up to optical media" screen ends by handing everything off to a different program, ImgBurn,
to actually burn a real disc — nothing here can automate that part anyway (there's no way to script an actual
disc burner), and `test-harness/worker-ipc` already thoroughly proves the app *prepares* the right data for
that step correctly. So this test skips straight to building its own one "disc" directly, and focuses on what's
genuinely new here: actually reading from a (simulated) disc and recovering files through the real screen, with
one disc.

## How to use it

```
node test-harness/ui/test-recover-single-disc.js
```

What it does, in order: makes a small random test folder, builds and mounts a `.iso` from it, opens the real
app, tells it to pretend a folder-picker click already chose a fresh scratch folder, then clicks all the way
through the wizard — choose that output folder → click Next → wait for the app to notice the mounted disc and
read it → click "all discs processed" → tick "select all" → click "recover selected data" → confirm → wait for
the copy to finish → click "Ok" on the success message. Then it checks every recovered file's fingerprint
against the original, and finally un-mounts the disc and deletes its own scratch files — but **only if
everything passed**. If something fails, it deliberately leaves everything in place (the test folder, the
recovered folder, the `.iso`) so it can actually be looked at afterward instead of guessing, and also saves a
screenshot of whatever the app looked like at the exact moment something went wrong.

**A timing quirk worth knowing about:** clicking straight from confirming "insert disc(s)" to waiting for
"recovery successful," with essentially no pause in between (which only an automated script would ever do - a
real person always takes at least a little time reading the screen between clicks), can occasionally cause two
of the app's own internal steps to collide, silently doing nothing while the app still (wrongly) reports success.
A short, deliberate pause before that last click reliably avoids it - already built into this script.

## `test-incremental-backup.js`

```
node test-harness/ui/test-incremental-backup.js
```

Clicks all the way through the real "Cumulative backup" wizard: main menu → Cumulative backup → "Source
directory path" (stubbed to a generated random tree) → "Backup directory path" (stubbed to a fresh empty scratch
folder) → Next → waits for the app's own `diff` to finish and the diff tree to render → "Select all" → Next → the
preview dialog → "Write to the backup" → "Yes" on the confirmation → waits for the copy to finish → "Ok" on the
success dialog. Then verifies the backup folder against the manifest by hash (`verify-manifest.js`).

Purely folder-to-folder — no `.iso`/optical-media simulation needed, so the only dialog stubbed is the native
"choose a folder" picker (`dialog.showOpenDialog`, same mechanism `test-recover-single-disc.js` uses), queued to
return the source path on its first call and the target path on its second.

Deliberately scoped to a single pass through the wizard (generate → sync to an empty target → verify), same
scope as `test-recover-single-disc.js` — proving a *second* sync only re-copies what actually changed (not the
whole tree again) is exactly what `worker-ipc/test-incremental-backup.js` already proves thoroughly by talking to
the engine directly.

## `test-sync-dirs.js`

```
node test-harness/ui/test-sync-dirs.js
```

Clicks all the way through the real "Synchronize directories" wizard: main menu → Synchronize directories →
"Path to the template directory" → "Path to the directory to be synchronized with the template" (both stubbed) →
Next → the destructive-operation warning dialog → "Continue" → the preview dialog (the same repurposed
`IncrementalDialogComponent` the Cumulative backup wizard uses) → "Write to the backup" (which starts
**disabled** until the preview stream finishes — this script relies on Playwright's normal click-actionability
wait for that, no extra polling needed) → "Yes, continue" on the sync confirmation → waits for the copy+delete to
finish → "Ok" on the success dialog. Then verifies the target folder exactly matches a freshly rebuilt manifest
of source's final state — `verify-manifest.js`'s own `EXTRA` detection is what actually proves deleted files are
gone, not just that the expected ones are.

**This is the one UI script that can genuinely delete real files** — see `worker-ipc/README.md`'s
`test-sync-dirs.js` section for the full IPC-level safety writeup. This script adds its own on-disk check: right after
the preview dialog appears — before "Yes, continue" is ever clicked — it asserts the two deliberately-planted
"leftover" files (one in an existing directory, one alone in its own directory) are still present, failing loudly
if the preview stage itself touched anything.

## `test-recover-multi-disc.js`

```
node test-harness/ui/test-recover-multi-disc.js
```

The natural extension of `test-recover-single-disc.js` to TWO discs, not one — the recovery wizard's own
inherently multi-step nature (read every disc's listing first, then separately re-insert whichever discs are
actually needed to copy the real bytes) is exactly what that single-disc test deliberately left uncovered. What
it covers, all at once, on a single run:
- A real nested tree (`--max-depth 4`) plus edge cases (a zero-byte file, a unicode/space filename, an empty
  directory) plus two MORE empty directories this script plants itself, split evenly between the two discs while
  preserving each file's relative subdirectory - a shared parent directory legitimately ending up split across
  two different physical discs, which is normal for how real large backups get spread across media.
- A large file's REAL split pieces (via the app's own `partition-backup-to-optical-media`, same as
  `worker-ipc/test-large-file-split.js` and its proven-safe size constants) spread across the two DIFFERENT
  discs, reassembled during recovery via the wizard's own "Partial files detected - want me to reassemble them?"
  flow - a code path no other test here exercises (the worker-ipc large-file test proves the raw split+merge
  mechanism directly over IPC; this proves the recovery UI's own merge-offer screen, which only exists there).
- Full before/after directory-tree printouts (source, each disc's own contents before burning, and the final
  recovered result) via `lib/print-tree.js`.

**A real app behavior worth knowing before touching disc-swap logic:** `waitForOpticalDiskToBeMounted()`
(`worker.ts`) just checks "is *any* optical drive currently showing media" — it does **not** wait for an
eject-then-reinsert transition. So the previously-mounted disc must always be dismounted, and the next one
mounted, **before** clicking whatever button makes the app start waiting again — never the other order, or the
app immediately re-detects the same old disc and correctly rejects it as "already processed". There are two
separate swap cycles in this wizard: enumeration (reading each disc's file *listing* only, one at a time) and
recovery (re-inserting whichever discs are actually needed to copy the real bytes, in any order). This script
mounts disc 2 last during enumeration and lets the app detect it again, still mounted, as the first disc of the
recovery phase too — no swap needed there, since it's already exactly what's inserted.

**A genuinely intermittent timing variance worth knowing about:** the "wait for the combined files tree, click
Select all" step's own duration varies run to run - the "Select all" checkbox is CSS `visibility:hidden` (not
removed from the DOM - see `.hideThis` in `optical-disc-backup-data-retriever.scss`) while
`createFilesTreeForReconstructedBackupPaths()` builds the combined 2-disc tree, and how long that takes varies -
plausibly Electron/V8 JIT/cold-start variance, since every test run launches a brand-new process. This script
handles it with an explicit, generous (120s) `waitFor({state: 'visible'})` followed by a separate click, rather
than one combined wait-and-click call.

**Worth knowing if you add more empty directories to a multi-disc fixture:** the app tracks empty directories as
path entries the identical way it tracks files (see `getAllFiles`/`getAllFilesSet` in `worker.ts`), so two
identically-named empty directories on different discs are indistinguishable from a genuine duplicate filename to
its "does every disc have unique names" check, and it will correctly refuse the second one with "It looks like
the disk you inserted has some files in common with disks you inserted previously." Give each disc's own extra
empty directory a distinct name.

## `test-recover-from-json-metadata.js`

```
node test-harness/ui/test-recover-from-json-metadata.js
```

Exercises the recovery wizard's *other* entry point: the "Provide cold storage files metadata by importing a
JSON file" checkbox on step 1. This is a genuinely different code path from every other recovery test here —
`seedFromExternalMetadata` (`optical-disc-backup-data-retriever.component.ts`) computes each disc's ID directly
from the JSON's own file paths (schema-validated first against `src/app/schemas/filesMetadata.schema.json`), and
if valid, the wizard skips the entire "insert disc 1, insert disc 2, ..." *enumeration* dance and jumps straight
to file selection. Real discs are still needed afterward, during the *recovery* phase itself, to copy the actual
bytes of whichever files get selected — only the listing step is skipped.

**How the test JSON fixture is built — reusing the app's own real computation, not hand-constructed.** Rather than
hand-writing JSON that merely *looks* right against the schema, the script asks the app's own real worker IPC
(`get-file-paths-with-stats` — the exact same call `readAllDiscsToReconstructTheCompleteBackupFilePaths` itself
makes when physically reading a real disc) for each simulated disc folder's real file listing + stats, then
normalizes the paths the same way the real burn-time flow does before saving (see `lib/cold-storage-metadata.js`
— a literal prefix-string replacement, NOT `path.relative()`, which would silently strip the trailing separator
that marks an empty directory and change that disc's computed ID hash). The result is structurally identical to
what the app would have saved for real.

It also covers the same large-file-split-across-discs merge scenario `test-recover-multi-disc.js` proves for the
physical-disc-read path — one real split piece (via `partition-backup-to-optical-media`, same proven-safe size
constants) placed on each disc, reassembled during recovery via the wizard's own "Partial files detected" screen.

**A structural race worth knowing about if this script (or the wizard) is ever changed:** the mat-chip showing
the chosen JSON path appears on screen the instant a path is picked — *before* `afterJSONpathIsGiven()` actually
finishes reading + schema-validating it over IPC (`externalMetadataJSONpath` is set synchronously, then
validation is awaited, not the other way round — see `getJSON()` in
`recover-data-from-optical-media.component.ts`). Clicking "Next" before that validation round trip completes hits
`step1()`'s own "no valid JSON file has been selected yet" guard instead of proceeding. This script avoids it
with a short deliberate pause after the path appears.

## `test-backup-to-optical-media.js`

```
node test-harness/ui/test-backup-to-optical-media.js
```

Clicks through step 1 (source folder, "CD (700 MB)" medium, collection name, Next), the "too large" confirmation
chain (see below), the resulting "you will need N discs" confirmation, the JSON save-path dialog, and then - per
disc - "Send to ImgBurn" and its "Disc label" confirmation. Generates a source tree just over one CD's *effective*
capacity (700MB * the app's own 0.95 `maxOpticalMediumRepletionRatio` margin) via a small nested tree with edge
cases plus a real 700MB file, big enough on its own to force a real split.

**Covers a real large-file split, via this wizard's OWN unique confirmation-dialog chain.** Unlike
`add-missing-files-to-optical-media-cold-storage.component.ts`'s `partition()` (which hardcodes
`splitLargeFiles: true` unconditionally, every time - see `ui/test-add-missing-files.js`), THIS wizard's
`WriteToOpticalMediaProceed` tries *without* splitting first, and only on catching a
`FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC` error does it show its own confirmation chain: "Error - Too large files
found" → "Yes, split the large files" → a "Warning!" about the temp directory → "Ok, got it." (which retries the
whole call with `splitLargeFiles: true`, and is where the real 7-Zip split actually happens). The real 700MB file
reliably produces 3 discs (1 for the small normal files, 2 for the real ~500MB/~176MB split pieces - same
proven-safe combination as `worker-ipc/test-large-file-split.js` and `ui/test-add-missing-files.js`), each with
its own "Send to ImgBurn" step in the per-disc loop below. Split pieces are verified *structurally* (exact piece
count, exact first-volume size, total size within the same real-7z-overhead tolerance
`worker-ipc/test-large-file-split.js` already established) rather than by predicting 7-Zip's own output filenames
in advance.

**Why this needed a real design decision before it could be built at all: "Send to ImgBurn" launches real
ImgBurn.** `createIBB_file` (`app/workers/worker.ts`) does two things every time it's called, unconditionally, no
matter how it's invoked: writes a real `.ibb` project file (safe), AND spawns whatever `ImgBurn.exe` is configured
in `appData/config.json` on it - both coupled inside one function, with no "just write the file" mode. So this
script backs up the exact raw text of the real `appData/config.json`, writes a version with `imgBurnExecutablePath`
pointed at a harmless no-op `.bat` stub (`@echo off` - exits instantly, does nothing) it creates in its own scratch
folder, then ALWAYS restores the original byte-for-byte in a `finally` block, however the run ends. `createIBB_file`
rereads config.json fresh from disk on every call (not cached), so this is enough to exercise the real `exec()` call
without ever launching your actual ImgBurn.

**What it actually checks:** the `.ibb` file's `[START_BACKUP_LIST]`...`[END_BACKUP_LIST]` section is a real,
separate piece of app logic (`insertBranch_for_IBB_creation`) that flattens each disc's selected tree into
`F|name|parentPath|fullSourcePath` / `D|name|parentPath|fullSourcePath` lines. This script reads each real
generated `.ibb` file back and compares its `fullSourcePath` fields directly against a plain recursive filesystem
walk of the source tree: every real file must appear in **exactly one** disc's `.ibb` (a physical file can only
be burned once), every real directory must appear in **at least one** (directories legitimately CAN repeat
across discs, since each disc's `.ibb` is built from a fresh, disc-local tree and needs its own directory
declared wherever it has files on that particular disc).

## `test-add-missing-files.js`

```
node test-harness/ui/test-add-missing-files.js
```

Deliberately scoped to the JSON-metadata entry point only - the "no JSON, physically re-insert every existing
disc one by one" path reuses the exact same `<optical-disc-backup-data-retriever>` component (and
`getCombinedFilePathsFromAllOpticalDiscs`) that `test-recover-multi-disc.js` already thoroughly exercises, so it
isn't the genuinely new thing worth proving here.

**What makes this flow genuinely different from every other test here:** every other backup/recover test either
starts a cold storage from scratch or reads one back unchanged. This is the one flow that *adds* to an
already-existing cold storage - it has to diff a "master" folder against an existing cold storage's own listing
to find only the genuinely new files, correctly *exclude* the ones already backed up, continue the disc numbering
from wherever the existing collection left off, and merge the new discs' entries into the existing metadata JSON
without disturbing the old ones. Simulates an existing 1-disc cold storage by copying half of a generated tree's
NORMAL files into a separate folder and turning it into a metadata JSON via the app's own real
`get-file-paths-with-stats` IPC (same technique as `test-recover-from-json-metadata.js`, shared via
`lib/cold-storage-metadata.js`); the other half - plus the one built-in empty-directory edge case AND a real
700MB file - is deliberately left out of that JSON, so the wizard's own diff has to discover all of it as missing
on its own.

**It also covers a real large-file split**, genuinely different here than everywhere else it's tested: unlike
`backup-to-optical-media.component.ts`'s `WriteToOpticalMediaProceed` (which tries WITHOUT splitting first, only
retrying with `splitLargeFiles: true` after hitting a "file too large" error, behind a confirmation dialog chain),
THIS wizard's `partition()` calls `partitionBackupToOpticalMedia` with `splitLargeFiles` hardcoded to `true`,
unconditionally, every time. The bin-packing arithmetic (two separate passes pushed onto the same shared array -
ordinary files first, then the large file's real split pieces) reliably produces exactly 3 new discs: 1 for the
small missing files, 2 for the ~500MB/~176MB real split pieces. Each disc's "Send disk N to ImgBurn" button
already has the disk number in its own text (unlike `backup-to-optical-media.component.ts`'s identically-labeled
ones), but its STEP still needs selecting first - `mat-stepper` only keeps the *currently selected* step's
content actually attached to the DOM, so only one disc's panel is ever attached at a time.

Like `test-backup-to-optical-media.js`, this clicks "Send to ImgBurn" for real, using the same ImgBurn-redirect
technique (shared via `lib/ibb-tools.js`).

**Verifies four independent things:** (1) the real generated `.ibb` files (across all 3 new discs, combined)
contain *exactly* the missing files/directories - no more (an already-backed-up file leaking in would mean the
diff logic itself is broken), no less - plus the large file's real split pieces, verified *structurally* (exact
piece count, exact first-volume size, total size within the same real-7z-overhead tolerance
`worker-ipc/test-large-file-split.js` already established) since 7-Zip's own output filenames can't be predicted
in advance; (2) the updated metadata JSON preserves the original disc's entries completely untouched while
correctly appending every new disc's entries; (3) every new disc's actual burned volume label and its on-screen
"please label this disc as disc N" instruction correctly continue the numbering ("Disc 2", "Disc 3", "Disc 4")
from the 1 disc already in the existing collection, both computed once via `getNextDiscNumber()` so they can
never drift apart; (4) the split pieces' paths are correctly represented, without a stray leading backslash, in
both the `.ibb` and the JSON.

`add-missing-files-to-optical-media-cold-storage.component.ts`'s `ngAfterViewInit()` unconditionally opens a
"This app is a work in progress..." warning dialog (title "Warning", a default single "Ok" button) the instant
the wizard loads, before step 1's own form is usable at all - not a bug, just something the script has to click
through before anything else.

## `capture-readme-screenshots.js`

```
node test-harness/ui/capture-readme-screenshots.js
```

Not a test - no pass/fail assertion, no verification step. It drives the real app through a small, harmless
slice of EVERY one of the app's 5 main-menu features, one after another (each in its own fresh app launch), and
saves SEVERAL real screenshots per feature into `docs/screenshots/` - deliberately more than any one feature
strictly needs in a README, so there's something to actually choose between:

- `main-menu.png`
- `backup-to-optical-media/` - step 1 filled in, the "you will need N discs" confirmation, step 2's burn screen.
- `incremental-backup/` - paths chosen, the diff screen, the preview dialog, the success dialog.
- `sync-dirs/` - paths chosen, the destructive-operation warning, the preview dialog, the success dialog.
- `recover-data/` - the JSON entry point selected, the combined files tree (twice: before and after "Select all").
- `add-missing-files/` - step 1 filled in, the diff results, the metadata-saved confirmation, the burn screen.

Kept deliberately fast and side-effect-free: every fixture tree here has no large file, so "Backup to optical
media" never hits the "too large, split it?" confirmation chain, "Add missing files"'s `partition()` still runs
but completes near-instantly (no real 5-minute 7-Zip wait), and neither of those nor "Recover data from optical
media" ever clicks "Send to ImgBurn" or mounts a real/virtual disc - each stops right at the screen worth
screenshotting. Nothing gets burned, split, or sent to any external program anywhere in this script.

One feature failing (a selector drifting after a UI change, say) doesn't stop the others - each is wrapped in its
own try/catch, with a pass/fail summary printed at the end.

Re-run it any time the UI changes enough that the README's screenshots go stale - it always overwrites the same
file names.

## `capture-recover-data-gif.js`

```
node test-harness/ui/capture-recover-data-gif.js
```

Not a test either - builds a short, real animated GIF of the "Recover data from optical media backup" wizard's
JSON entry point (the same click-through as `capture-readme-screenshots.js`'s `captureRecoverData`), for embedding
directly in the top-level README - see `docs/media/README.md`.

This does NOT use Playwright's built-in `recordVideo` - that was tried first (a `launchApp(extraLaunchOptions)`
param exists on `launchApp()` in `worker-ipc/call-worker.js` for exactly this, still there since it's a harmless,
generic passthrough every other caller ignores by passing none), but it's a confirmed, unresolved upstream
Playwright/Electron/Windows bug: enabling it made the app window open completely blank (`window.electronAPI`
never appeared, so `launchApp()`'s own wait timed out) - found for real (2026-08-30), matching publicly reported
Playwright issues (Electron + `recordVideo` loading blank / timing out on Windows / producing zero-length
`.webm`s). Chasing a workaround for someone else's unresolved bug wasn't worth it - this script sidesteps it
entirely by only ever using the already-proven-reliable `win.screenshot()`, stitching a handful of real
screenshots into one GIF via `pngjs` (PNG -> raw RGBA) + `gif-encoder-2` (RGBA frames -> GIF), both pure JS, no
native build step, no ffmpeg. Each screenshot is downsampled first (a small nearest-neighbor resize written
inline in the script - not worth its own dependency) so the committed GIF stays a reasonable size.

Unlike the equivalent screenshots (which deliberately stop before mounting anything), this one goes all the way
through a REAL recovery: the fixture includes a real large file, split for real via `partition-backup-to-optical-
media` (`splitLargeFiles: true`) with one piece placed on each disc - same technique as
`ui/test-recover-from-json-metadata.js`. Builds two real `.iso` files, mounts disc 1, clicks through the "insert
disc(s)" info dialog, waits for disc 1's real copy, swaps to disc 2 (dismount/mount), then clicks through the
real "Partial files detected" / "Yes, reassemble" merge offer before the final "Data recovery successful" dialog.
Needs no optical media already mounted (same `assertNoOpticalMediaAlreadyMounted()` guard the real recovery tests
use) and cleans up the app's own real temp/cache copies of the split pieces afterward. Prints the final frame
count, dimensions, and file size when it finishes.
