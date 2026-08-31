# Testing this app

This app's backup/split/recover/sync flow is tested by an automated test harness living in `test-harness/` -
built to make it possible to verify the app actually works, end to end, without physically inserting optical
discs or manually clicking through every screen by hand each time something changes.

This document is the project-level overview: what exists, how to run it, what it has actually proven, and what
real bugs it has found. Each subfolder under `test-harness/` has its own README with much more implementation
detail and blow-by-blow debugging history - this file is the map, not the territory.

## Quick start

```
node test-harness/worker-ipc/test-partitioning.js       # fastest, safest place to start
node test-harness/ui/test-recover-single-disc.js        # a full on-screen wizard, clicked through for real
node test-harness/cleanup.js --dry-run                  # see what (if anything) needs cleaning up
```

**Requirements to run any of these:**
- A real, interactive Windows desktop session. These scripts launch the actual Electron app; that fails with
  `Process failed to launch!` in a headless/remote/no-desktop context (e.g. an AI coding agent's own sandboxed
  tool environment) even though non-GUI commands like `electron.exe --version` work fine there. Run them from
  your own terminal on the machine you actually use.
- The app already built (`npm run build:prod`, or just have `app/main.js` present - these scripts launch
  `app/main.js` directly, not the packaged installer under `dist/`).
- 7-Zip and (for optical-media tests) ImgBurn configured in `appData/config.json`, same as the app itself needs.

## The two testing styles

**`worker-ipc/`** - talks directly to the app's hidden "worker" process (the one that does real file
splitting/merging/copying) over the exact same IPC messages the on-screen buttons send, skipping the UI
entirely. Faster, and tests the real file-handling engine in isolation.

**`ui/`** - drives the real, visible app window through [Playwright](https://playwright.dev), clicking through
actual screens the way a person would. Slower, but this is the only style that can catch problems in the screens
themselves (a button that doesn't do what it says, a dialog that never appears, a checkbox that lies about its
own state) rather than just the underlying engine.

Both styles use a shared foundation:
- `generate-random-tree.js` - generates a folder of random test files (with optional nested subdirectories, a
  zero-byte file, a unicode-named file, and an empty directory) plus a manifest of every file's sha256
  fingerprint.
- `verify-manifest.js` - re-hashes a folder and compares it against a manifest, reporting exactly which files are
  `MISSING`, `MISMATCH` (corrupted), or `EXTRA`. This is the actual pass/fail authority for almost every test
  here - not "no error was thrown," but "every byte matches."
- `lib/print-tree.js` - prints an indented before/after directory listing (every file with its size, empty
  directories marked as such) for visual inspection - a convenience on top of the byte-for-byte check above, not
  a replacement for it.
- `optical-media/` (`OpticalMediaTestKit.psm1`) - makes a `.iso` file look exactly like a real inserted optical
  disc to Windows (`Mount-DiskImage`/`Dismount-DiskImage`), so disc-related tests never need a physical disc or
  drive.

## What's covered, and what each test actually proves

| Script | Style | Proves |
|---|---|---|
| `worker-ipc/test-partitioning.js` | worker-ipc | The bin-packing logic that decides which files go on which disc, within capacity. |
| `worker-ipc/test-merge.js` | worker-ipc | Reassembling a large file's split `.part.NNN` pieces back together (small stand-in volumes, not real 500MB+ ones). |
| `worker-ipc/test-incremental-backup.js` | worker-ipc | Cumulative backup: a first sync copies everything; a second sync after changes reports and copies *exactly* the changed files (not the whole tree again), proven via mtime, not just re-hashing. |
| `worker-ipc/test-sync-dirs.js` | worker-ipc | Synchronize directories: copies changes AND deletes files that only exist in the target. The one script here that can genuinely delete real files - see its own safety writeup. |
| `worker-ipc/test-large-file-split.js` | worker-ipc | The REAL large-file split, at the real 500 MiB volume size (not `test-merge.js`'s smaller stand-in) - generates a real 700MB file, lets the app split it for real, reassembles it, and hash-verifies the result. |
| `ui/test-recover-single-disc.js` | UI | The full "Recover data from optical media backup" wizard, one disc, clicked through on screen. |
| `ui/test-incremental-backup.js` | UI | The full "Cumulative backup" wizard, clicked through on screen. |
| `ui/test-sync-dirs.js` | UI | The full "Synchronize directories" wizard, clicked through on screen - the one UI script that can genuinely delete real files. |
| `ui/test-recover-multi-disc.js` | UI | **The most thorough physical-disc test here.** The recovery wizard across TWO discs, with a real nested/edge-case tree split between them, AND a large file's real split pieces spread across the two *different* discs, reassembled during recovery via the wizard's own merge-offer screen - a code path no other test exercises. |
| `ui/test-recover-from-json-metadata.js` | UI | The recovery wizard's *other* entry point: seeding the disc listing from a provided cold storage metadata JSON file instead of physically reading every disc - including the same large-file-split-across-discs merge scenario as the row above, proven this time on a JSON-seeded disc listing. |
| `ui/test-backup-to-optical-media.js` | UI | The "Backup to optical media" wizard, up to and including "Send to ImgBurn" (with the real ImgBurn launch safely redirected to a no-op stub), including a real large-file split via this wizard's own "too large" confirmation-dialog chain (it tries without splitting first, unlike `add-missing-files`'s always-split behavior). Checks that every source file/directory - and the large file's real split pieces - are correctly represented in the real generated `.ibb` file(s). |
| `ui/test-add-missing-files.js` | UI | The "Add missing files to optical media cold storage" wizard - the one flow that *adds* to an already-existing cold storage rather than starting fresh, including a real large-file split (this wizard always splits unconditionally, unlike backup-to-optical-media's). Checks the diff-against-existing-cold-storage logic (only genuinely new files/pieces reach the new discs, already-backed-up ones are correctly excluded), the merged metadata JSON, and correct continued disc numbering across all new discs. |

All 5 of the app's main-menu features now have an automated UI test. Not yet built: the "add missing files"
screen's *other* entry point (physically re-inserting every existing disc one by one, rather than importing a
JSON) - it reuses the same disc-enumeration component `ui/test-recover-multi-disc.js` already exercises, so it
wasn't the genuinely new thing worth proving first.

## Safety model

- Every script that writes files validates the destination path first (`resolveSafeRoot` in `lib/safety.js`) -
  refuses drive roots, your home folder, Desktop/Documents/Downloads, or system folders, even if pointed there by
  accident.
- Scratch data always lives under one hardcoded path, `%TEMP%\optical-backup-test-fixtures\` - nothing here ever
  writes real test data anywhere else.
- Anything that clears existing content requires an ownership marker proving *this tooling* created that folder
  - never a folder that merely happens to exist at the same path.
- Scripts that touch the app's own real temp/cache directory (`appData\tempFilesCanBeDeleted\`) refuse to run
  unless that directory is currently empty (besides its own marker) - protecting any real, in-progress backup
  you might have pending there.
- `worker-ipc/test-sync-dirs.js` and `ui/test-sync-dirs.js` are the only two scripts that can delete real files.
  Both always run a preview pass first with an explicit on-disk assertion that nothing was deleted, and only ever
  delete a small, explicit, hand-planted set of files - never anything computed or sweeping. See their own
  README sections for the full writeup, including a real naming trap found in the app's own IPC layer (not a
  bug - current behavior is correct, but easy to get backwards - see "Notable findings" below).
- A run you interrupt (Ctrl+C, closing the app window, a genuine failure) deliberately leaves its scratch data in
  place instead of cleaning up, so it can actually be inspected. Run `node test-harness/cleanup.js` afterward to
  clear it out (`--dry-run` to just see what it would remove first).

## Notable findings

Building and running this test harness surfaced several real, pre-existing issues in the app itself - each one
found by actually running the real code and checking real results, not by reading and assuming:

**Fixed:**
- `app/main.ts` was looking for its own compiled files in the wrong folder when launched a certain way (not the
  packaged installer), silently loading a blank page instead.
- **"Select all" didn't actually select anything on the first click**, in 4 different screens (recovering data,
  adding missing files, cumulative backup, backing up to optical media). The checkbox looked checked from the
  moment the screen loaded, so the first click actually *un*checked it (a no-op), and only a second click really
  selected everything.
- `appData/config.json` was missing `"setupAcknowledged": true`, causing the one-time "confirm your 7-Zip/ImgBurn
  paths" popup to reappear on every single startup instead of just once.
- **Every generated `.ibb` project file was silently written in the wrong text encoding.** `saveIBB_toDisk`
  (`app/workers/worker.ts`) correctly reads the `.ibb` template as UTF-16LE (a real ImgBurn-authored
  `IBB_TEMPLATE.ibb` genuinely is UTF-16LE), but wrote the modified result back with no encoding specified - Node
  defaults a plain string write to UTF-8, not UTF-16LE. Every real `.ibb` file this app has ever generated came out
  in a different encoding than its own template (and, presumably, than what ImgBurn itself expects) - a stray
  UTF-8 BOM even ended up literally encoding what was originally a UTF-16 BOM character. Found via
  `ui/test-backup-to-optical-media.js`'s first real run failing to find the `.ibb` format's own
  `[START_BACKUP_LIST]` marker in a freshly generated file; confirmed by reproducing the exact read/write sequence
  standalone and inspecting the raw output bytes. Fixed by passing `{ encoding: 'utf16le' }` to the write too.
- **The on-screen "please label this disc as disc N" instruction could tell you the wrong disc number.**
  `sendToImgBurn` (`add-missing-files-to-optical-media-cold-storage.component.ts`) used the bare local disk index
  (always restarting at 1) for that message, while `createIBB_file`'s real burned volume label correctly continued
  the numbering from however many discs already exist in the collection - so adding a disc to an already-existing
  1-disc cold storage would tell you, on screen, to label your new disc "1" while its real embedded label said
  "Disc 2". This app's own recovery flow depends on discs being labeled to match their JSON order exactly, so
  trusting the wrong on-screen number could genuinely break a future recovery. Found by direct code reading while
  building `ui/test-add-missing-files.js`, not a live-run symptom. Fixed by computing the disc number once
  (`getNextDiscNumber()`) and having both places use it.
- **A leading backslash corrupted every split piece's path - the same defect found independently in TWO
  components.** `tempPath`/`tempDataDirectoryPath` (fetched fresh via `getTempDataDirectoryPath()`) never had a
  trailing backslash ensured before being used to strip the temp directory's prefix off a split piece's real
  path - unlike `backup.targetPath`/`sourcePath`, which do get one ensured elsewhere in the same components.
  Stripping an un-trailed prefix left a stray leading backslash behind, producing an empty-named root directory
  entry plus a doubled-backslash "large-files" entry in the real `.ibb` (and, in `add-missing-files`'s case, the
  equivalent corruption in the merged JSON too) - for every large file either wizard has ever split. First found
  in `add-missing-files-to-optical-media-cold-storage.component.ts` once `ui/test-add-missing-files.js` was
  extended to cover a real large-file split; the identical defect was then deliberately checked for and found in
  `backup-to-optical-media.component.ts` too, once `ui/test-backup-to-optical-media.js` got the same treatment.
  Confirmed via each real `.ibb`/JSON output. Fixed the same way in both: a one-line trailing-backslash-ensure
  right after the temp path is fetched.

**Found, documented, deliberately left unfixed (the user's call, not reachable through the real app UI):**
- `partitionBackupToOpticalMedia` (`app/workers/worker.ts`) can loop forever if a single real split piece (fixed
  at 500 MiB) is bigger than whatever disc capacity it's given - the pass that assigns split pieces to "discs" is
  missing the same "too big for any disc" guard the ordinary-file pass already has. Not reachable through the
  real UI (the smallest selectable medium, a 700MB CD, is always bigger than a 500 MiB piece), so this has never
  affected real usage - it only surfaced because a test calls the function directly with too small a capacity.
  See `test-harness/worker-ipc/README.md`'s `test-large-file-split.js` section for the full diagnosis.
- `WorkerCommunicator.deleteFilesAndDirsForDirSync`'s parameter is named `previewOnly` and sent over IPC that
  way, but the worker's own handler passes it straight through, unchanged, into a parameter that's actually
  named `commit` - there's no inversion, so `previewOnly: true` actually **commits** deletions and
  `previewOnly: false` actually **previews only**, backwards from what the name suggests. The app only works
  correctly today because both real call sites happen to pass the value they mean for `commit`, with an inline
  comment overriding the misleading parameter name. Not a functional bug (current behavior is correct), just a
  landmine worth knowing about if that code is ever touched.

**One requested hardening (not a bug):** the 500MB large-file split-piece size in `worker.ts` was pulled out of a
bare number in a command string into a named, documented constant (`LARGE_FILE_SPLIT_VOLUME_SIZE_MIB`) - same
behavior, just no longer a silent magic number.

**Found and fixed in the test harness itself, not the app:** `ui/test-recover-from-json-metadata.js`'s own
JSON-fixture-building helper originally used `path.relative()` to build each disc's file paths for the metadata
JSON. `path.relative()` silently normalizes away trailing separators - but the app represents a genuinely empty
directory as a path entry that *always* ends in one (see `getAllFiles`/`getAllFilePathsWithStats` in `worker.ts`),
and the real burn-time path builds that same string via a literal prefix replacement, which preserves it. Losing
that one trailing character changes the disc's computed ID hash whenever it contains an empty directory, causing
recovery to reject the correct disc as "not one of the ones you need." Found by reimplementing both sides' real
hash computation in a standalone script and diffing the path lists directly - see `test-harness/ui/README.md`'s
own section on this script for the full diagnosis. Fixed in the test script; not an app bug.

**Also found and fixed in `ui/test-backup-to-optical-media.js` itself:** an early version targeted each disc's
"Send to ImgBurn" button by DOM order (`.nth(i)`), assuming both discs' buttons stay in the DOM simultaneously.
`mat-stepper` only keeps the *currently selected* step's own content actually attached to the DOM, so after
navigating to disc 2's step, disc 1's button was gone entirely - not hidden - making `.nth(1)` ask for a match
that never existed. Fixed by dropping the index (only one disc's panel is ever attached at a time, so the plain
locator is already unambiguous). A separate cleanup-ordering bug was also found and fixed: real `.ibb` files were
being deleted before the verification step ever got to read them.

## Debugging lessons (useful the next time something breaks)

- Print a line for every single click/step, not just a few checkpoint messages - pinpoints exactly where a hang
  or failure happened instead of one confusing silent gap.
- Take a screenshot automatically the instant anything fails, and compare before/after screenshots directly
  rather than assuming - this is what actually settled several "is this really a bug?" questions in this
  project's history (a checkbox that looked unchecked was proven checked by comparing screenshots taken
  immediately before and after the click).
- When a step's timing is genuinely variable (not just "add a bigger timeout and hope"), separate *waiting* for a
  precondition from *acting* on it into two distinct steps - this fixed more than one real intermittent failure
  in this test suite, where a single combined "wait and click" call was less reliable than the same two things
  done one after another.
- A live diagnostic (extra logging, a screenshot, a dialog-content tracer) can itself become the thing that's
  wrong - one investigation in this project's history chased a phantom "duplicate dialog" that turned out to be
  an artifact of the diagnostic's own polling technique, not a real issue. Fix the diagnostic's own reliability
  before trusting what it reports.
- Before building a test around a destructive operation (anything that can genuinely delete real files), trace
  the exact code path by reading it, not by inference - this project found a real, backwards-from-its-name IPC
  parameter this way before ever running anything against it for real.
- When a suspect function's own behavior is in question (does it write what you think it writes, in the encoding
  you think it uses?), reproduce its exact read/write sequence standalone and inspect the raw output bytes
  directly - this is what caught the `.ibb` UTF-8-vs-UTF-16LE encoding bug conclusively, rather than guessing from
  a downstream parse failure alone.
- A UI framework's own component-instance visibility (e.g. Angular `@ViewChildren` finding every step's component
  at once) does not prove its DOM CONTENT is simultaneously attached and interactable - `mat-stepper` here keeps
  only the currently selected step's markup in the DOM, a distinction that broke a `.nth(i)`-based locator built
  on the wrong assumption. When in doubt, check a failure screenshot directly rather than trusting an assumption
  about how a component library renders.
- Not every bug needs a live run to find - the disc-numbering label mismatch (see Notable findings above) was
  caught by directly reading the two places a value gets computed and noticing they used different formulas,
  before the test that would eventually confirm it ever ran once. The on-screen text and the real burned label
  would each look individually correct in isolation - only comparing them side by side reveals the mismatch.
- When a test's own "expected" ground truth is built by reasoning about what a data structure *should* contain,
  double-check that reasoning against what the relevant code actually STORES versus what it separately
  SYNTHESIZES at output time - an early `ui/test-add-missing-files.js` expected-directories list matched what the
  cold storage metadata JSON stores (leaf items only) but not what the real `.ibb` file's own tree-flattening
  logic additionally synthesizes (a directory entry for every intermediate ancestor), because they are genuinely
  different things computed by different code, not the same list read twice.
- A locator matching more than one element (a Playwright strict-mode error) proves those elements are all
  DOM-present - it does NOT prove they're all simultaneously visible. A step in `ui/test-add-missing-files.js`
  first removed a needed tab-navigation click after seeing a strict-mode error on a shared heading, reasoning
  (incorrectly) that every panel must therefore already be visible - a failure screenshot showed the real answer:
  all 3 panels were present in the DOM, only one was actually expanded.
- A raw IPC call fired immediately after launching the app, with no UI interaction first, can race the app's own
  startup logic if they share a request key and the IPC contract has no per-request correlation ID -
  `ui/test-add-missing-files.js` hit this against `app.component.ts`'s own startup housekeeping check (both call
  the same `get-file-paths-with-stats` key). No other script here had hit it, because they all do several UI
  clicks first, long enough for any startup-time call to finish on its own.
- Extending an already-passing test with a genuinely new scenario can surface bugs the original scenario never
  exercised - the leading-backslash defect in split-piece paths (see Notable findings above) only existed on the
  large-file code path, and would have stayed hidden indefinitely in a test that never added one.
- Once a bug is confirmed real in one component, check sibling components for the identical pattern before
  assuming it's isolated - the leading-backslash defect above turned out to exist independently in TWO
  components sharing the same temp-directory-path handling pattern, found only because the second one was
  deliberately checked once the first was confirmed real, not because a second test happened to stumble onto it.

## Cleaning up

```
node test-harness/cleanup.js            # actually removes leftovers
node test-harness/cleanup.js --dry-run  # only reports what it would remove
```

Clears `%TEMP%\optical-backup-test-fixtures\` and the app's real `appData\tempFilesCanBeDeleted\` (down to just
its ownership marker), and reports (never touches) any currently mounted optical media. See
`test-harness/README.md`'s own section on it for the full detail, including what to do if a leftover mounted
`.iso` blocks removal of the folder it's sitting in.
