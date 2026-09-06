# Test harness

This folder holds scripts that test the backup / split / recover flow **automatically** — without you having to
physically insert optical discs, and without you having to click through the app by hand every time you want to
check something still works.

See "Coverage" further down for what's currently tested.

## Why this exists (the problem it solves)

Testing this app for real normally means: creating some test files by hand, burning them to an actual disc (or
at least having one to insert), clicking through several screens, waiting, and then eyeballing whether the
recovered files look right. That's slow, and "eyeballing whether it looks right" isn't a real check — a byte
could be wrong and you'd never notice. This folder replaces every one of those manual steps with a script:

- Instead of creating test files by hand → a script generates a randomized folder of files for you.
- Instead of physically inserting a disc → a script makes a `.iso` file *look like* a real inserted disc to
  Windows (more on this below).
- Instead of clicking through the app → a script clicks the buttons for you, in the right order.
- Instead of eyeballing the result → a script compares every recovered file's exact fingerprint (hash) against
  the original, so "it passed" actually means every byte matches.

## Some terms explained (read this if any of the words below are new to you)

**Node script** — a small program you run by typing `node <filename>.js` in a terminal. Nothing fancier is
needed to run any script in this folder; you don't need to understand JavaScript to use them.

**Playwright** — a tool that can *operate an app the way a person would*: it opens the real app, "sees" what's
on screen, clicks buttons, types into fields, and reads back what happened — like a very fast, very literal
robot sitting at your keyboard and screen. `test-harness/ui/` uses this to click through the actual recovery
wizard.

**Mounting an `.iso` file** — an `.iso` file is a single file that contains an exact byte-for-byte copy of
everything that would be on an optical disc. "Mounting" it means telling Windows "pretend this file is a disc
that just got inserted into a drive" — which is the exact same thing that happens when you double-click an
`.iso` file in File Explorer and it shows up as a new drive letter. Because Windows treats it exactly like a
real disc, the app can't tell the difference either — so this genuinely tests "reading from an inserted disc,"
it doesn't fake or skip that part. See `optical-media/README.md`.

**IPC ("Inter-Process Communication")** — this app is actually *two* programs talking to each other behind the
scenes: the window you see (the "renderer"), and a hidden "worker" that does the actual file-splitting/merging
work. They talk by sending small messages back and forth — that's IPC. `test-harness/worker-ipc/` sends those
exact same messages directly, skipping the on-screen buttons entirely, to test the file-handling logic on its
own. See `worker-ipc/README.md`.

**Stubbing a dialog** — when you click "choose a folder" in a real app, Windows pops up its own folder-picker
window and waits for a human to click something. A script can't click a window that isn't part of the app's own
screen, so instead these tests tell the app "when you'd normally show that picker, just pretend the user already
picked *this* folder" — skipping the popup entirely, safely, since we're choosing the answer ourselves.

**Manifest** — a small file listing every test file's size and a "hash" (a fingerprint computed from a file's
exact contents — if even one byte changes, the fingerprint changes completely). Comparing fingerprints after a
recovery, rather than comparing files directly, is fast and 100% reliable.

**Guard / safety check** — code in these scripts that double-checks it's about to do something safe *before*
doing it, and refuses (with a clear error) if something looks even slightly off — e.g. "is this folder actually
one I created, or might it be something real of yours?" See "Safety model" below.

## How it all fits together (the big picture)

Every real test in here is built from the same handful of LEGO pieces, always assembled in the same order. Once
you see the pattern once, every script in this folder reads the same way:

```
 1. GENERATE a folder of files, plus a "manifest" recording each file's real size + fingerprint
    (generate-random-tree.js, or generate-tree-from-json.js for an exact hand-authored layout)
                                        |
                                        v
 2. FEED that folder to the real app, one of two ways:
      - worker-ipc/  talks to the app's internal engine directly over IPC - no clicking, fastest,
                      best for pinning down exactly which piece of file-handling logic is right or wrong
      - ui/          drives the REAL on-screen app with Playwright, clicking through it exactly like a
                      person would - proves the whole feature works, screens included
    (if the test needs a "disc" to be involved, optical-media/ builds a .iso from a folder and mounts
    it first, so the app genuinely reads from what Windows treats as a real inserted disc)
                                        |
                                        v
 3. VERIFY whatever came out the other end (a recovered folder, a merged file, an updated JSON) against
    the manifest from step 1 (verify-manifest.js, or an equivalent direct check the script does itself)
                                        |
                                        v
                                 PASS or FAIL, with the exact difference printed if it's FAIL

 (cleanup.js sweeps up anything left behind by a run you interrupted, or that genuinely failed)
```

That's it - that's the entire architecture. Every script you'll ever run in this folder is just this pipeline,
assembled slightly differently depending on which of the app's features it's exercising. Once that clicks, the
"What's here" reference section below is really just "which generator, which of the two feed mechanisms, which
verification" for each individual script.

## Your first run, step by step

The best way to actually understand this is to run the smallest, safest script and read what it prints, since
every other script here is the same shape, just bigger. `worker-ipc/test-partitioning.js` is a good first one:
it's fast (a few seconds), and it only ever *reads* files (see `worker-ipc/README.md` for why it's specifically
called out as "checked to be safe first").

**Before you start:** this needs to run on your own machine's desktop (not a remote/headless environment - see
the "⚠️ This needs a real screen/desktop to run" warning in `worker-ipc/README.md`), and 7-Zip has to be
installed with its path set correctly in `appData/config.json`'s `_7zipExecutablePath` - the same requirement
the real app itself has for splitting/merging large files.

```
node test-harness/worker-ipc/test-partitioning.js
```

Here's what you'll see, and what each part means:

1. `Checking the app's real temp/cache directory is safe to use...` - **step 2 of the pipeline above** getting
   ready: before touching anything, the script confirms the app's own real scratch folder either doesn't exist
   yet, or already carries the app's own "I created this" marker (see "Guard / safety check" above). This is the
   app's OWN real folder, not a throwaway test copy - see `worker-ipc/README.md`'s "Why check the temp folder
   first?" for exactly why that matters.
2. `Generating test tree at ... / Generating random test tree under: ...` then a file count and total size -
   **step 1**: `generate-random-tree.js` is spawned as a child process (you're seeing its own console output),
   building a small folder of random files under `test-harness/generated-fixtures/` and writing a
   `.manifest.json` file right next to it.
3. `Source tree (before): ...` followed by an indented file listing - a human-readable snapshot of exactly what
   got created, via the shared `lib/print-tree.js` helper. Every script here prints one of these before AND
   after its actual operation, specifically so you can SEE what the app did, not just trust a pass/fail line.
4. `Launching the app... / Calling partition-backup-to-optical-media over real IPC...` - **step 2**: the real,
   already-built app is launched (you may briefly see its windows appear), and this script sends it the exact
   same internal message the on-screen "Backup to optical media" wizard sends when it asks "how would you split
   these files across discs of this size?" - skipping the screen entirely.
5. `App reports N disc(s) needed.` then `Computed partitioning (after):` with a per-disc breakdown (file count,
   total bytes, and every single file's path) - **step 3**, but done inline in this particular script rather
   than via a separate `verify-manifest.js` call: since nothing gets copied anywhere (this is a bin-packing PLAN,
   not a file copy), the script lists exactly what the app decided to put on each disc, which the same run then
   checks: every file from the manifest accounted for exactly once, and no disc over its size limit.
6. A final `PASS - ...` or `FAIL - ...` line, and the process exits with code 0 (pass) or 1 (fail) - the same
   convention every script here follows, so you can tell success from failure without reading the whole log.

**What to try next**, once that makes sense:
- `node test-harness/generate-tree-from-json.js --spec test-harness/examples/tree-spec.example.json --split-plan test-harness/examples/split-plan.example.json` -
  see exactly what gets created on disk (`test-harness/generated-fixtures/` - go look at the folder yourself),
  without needing to launch the app at all.
- Pick one script from `ui/README.md` and run it - this time you'll actually watch the real app's windows open
  and get clicked through automatically (each script pauses 5 seconds after every click specifically so you can
  watch it happen - see `ui/README.md`'s own intro).
- If anything ever fails, or you interrupt a run partway (Ctrl+C, closing the app window): the scratch data is
  deliberately left in place under `test-harness/generated-fixtures/` for you to look at (see "Safety model"
  below for why), and `node test-harness/cleanup.js --dry-run` will tell you exactly what's left over without
  touching anything.

## What's here

| Folder / file | Plain-language summary | Status |
|---|---|---|
| `generate-random-tree.js` | Makes a folder full of random test files, plus a manifest of their fingerprints | Proven |
| `generate-tree-from-json.js` | Makes a folder matching an exact, hand-authored JSON spec instead of a random one - including files already split into real large-file parts | Proven |
| `examples/` | Ready-to-run example JSONs for `generate-tree-from-json.js` | Proven |
| `verify-manifest.js` | Checks a folder's files against a manifest and reports exactly what's wrong, if anything | Proven |
| `cleanup.js` | Removes leftover scratch data from interrupted/failed test runs | Proven |
| `optical-media/` | Makes a `.iso` file look like an inserted disc to Windows | Proven |
| `worker-ipc/` | Talks directly to the app's file-splitting/merging/incremental-backup/sync-dirs engine, skipping the on-screen buttons | **PASSING** |
| `ui/` | A robot (Playwright) clicks through real on-screen wizards - all 5 main-menu features: "recover data" (both by physically reading discs and by importing a cold storage metadata JSON), "Cumulative backup", "Synchronize directories", "Backup to optical media", "Add missing files to cold storage" | **PASSING** |
| `lib/` | Shared helper code every script above imports from, so the same logic isn't copy-pasted everywhere - see below | Proven |

Each subfolder has its own README with exact commands to run and more explanation.

### `generate-random-tree.js`
```
node test-harness/generate-random-tree.js --files 60 --max-size 5000000 --disk-capacity-bytes 700000000
```
This creates a new folder full of randomly-named, randomly-sized files (and a few tricky edge cases on purpose
— a zero-byte file, a file with unicode/accented characters in its name, an empty folder — since those are
exactly the kind of thing that trips up backup software). It also writes a manifest file next to it.

Useful flags:
- `--root <path>` — where to create the folder. If you don't pass this, it picks a fresh folder under
  `test-harness/generated-fixtures/` automatically, so most of the time you don't need to think about this at all.
- `--large-file-bytes <n>` — also creates one deliberately oversized file, useful for testing the
  "split large files across discs" feature specifically.
- `--seed <n>` — gives you the *same* random folder every time you use the same number, if you want a
  repeatable test rather than a fresh random one.
- `--reset` — wipes out a previous folder at `--root` before making a new one (only works if that folder was
  created by this same script — see "Safety model" below for why).
- `--no-edge-cases` — skips the zero-byte/unicode/empty-folder cases if you just want plain random files.

Run `node test-harness/generate-random-tree.js --help` to see the full list any time.

### `generate-tree-from-json.js`
```
node test-harness/generate-tree-from-json.js --spec my-tree.json --split-plan my-split-plan.json
```
For when you need a SPECIFIC file layout instead of a random one - exact paths and sizes, hand-authored as JSON.

Two JSON files:
1. `--spec` (required) — what to create. A flat array of `{ path, stats: { size, isDirectory } }` entries, in
   the exact same shape as one disc's entries in the app's own real cold storage metadata JSON (see
   `src/app/schemas/filesMetadata.schema.json`) — deliberately, so it's a format you already know rather than a
   new one to learn. `size` is always in **bytes** (same as Node's own `fs.Stats.size`) — e.g. `700000000` means
   700,000,000 bytes (~700 MB), never KB/MB/GB directly.
2. `--split-plan` (optional) — which of the `--spec`'s files should show up ALREADY split into real large-file
   parts (`<name>.part.001`, `.002`, ...) instead of one whole file — simulating a disc that already has a large
   file's real split volumes burned onto it. Its `volumeSizeMiB` field is in **MiB** (spelled out in the field
   name on purpose - e.g. `500` means 500 MiB per volume, ~524,288,000 bytes). This really runs the app's own
   configured 7-Zip binary to produce genuine multi-volume archives (a hand-rolled byte-chunk split would NOT be
   recoverable by the real app's own merge step) — see the script's own top comment for the full explanation and
   JSON examples.

Produces the exact same `manifest.json` shape `generate-random-tree.js` does, so `verify-manifest.js` and
everything else that reads that shape work unchanged — a split file's manifest entry still records its
ORIGINAL whole-file size/hash, since that's what a real recovery + merge is supposed to reproduce.

Run `node test-harness/generate-tree-from-json.js --help` to see the full option list any time.

**Example**: `test-harness/examples/tree-spec.example.json` + `test-harness/examples/split-plan.example.json` -
a ready-to-run pair covering nested folders, an empty directory, and a large file that comes out already split
into 2 real volumes. Try it (writes ~700 MB, takes a minute or two - the large file and its real 7-Zip split):
```
node test-harness/generate-tree-from-json.js --spec test-harness/examples/tree-spec.example.json --split-plan test-harness/examples/split-plan.example.json
```

Note this is separate from `test-harness/ui/tree-specs/` (see `ui/README.md`): these `test-harness/examples/`
files are generic, standalone samples for exploring `generate-tree-from-json.js` on its own - no `ui/test-*.js`
script reads from this folder, so editing a file here has no effect on any test. If you want to change what a
specific UI test actually generates, edit that test's own file under `ui/tree-specs/<test-name>/` instead.

#### Wiring this into an existing test

Every `worker-ipc`/`ui` test builds its own fixture by spawning a generator and reading the `.manifest.json` next
to it - swapping which generator gets spawned is a one-block change, since both produce the identical manifest
shape.

**Plain swap** - `worker-ipc/test-partitioning.js` currently builds its source tree with `generate-random-tree.js`:
```js
execFileSync(process.execPath, [
  path.join(__dirname, '../generate-random-tree.js'),
  '--root', root,
  '--files', '25',
  '--max-depth', '3',
  '--max-size', String(Math.floor(effectiveCapacity / 6)),
  '--seed', '12345',
], { stdio: 'inherit' });

const manifest = JSON.parse(fs.readFileSync(`${root}.manifest.json`, 'utf8'));
```
Wired to a hand-authored spec instead:
```js
execFileSync(process.execPath, [
  path.join(__dirname, '../generate-tree-from-json.js'),
  '--spec', path.join(__dirname, '../examples/tree-spec.example.json'),
  '--root', root,
], { stdio: 'inherit' });

const manifest = JSON.parse(fs.readFileSync(`${root}.manifest.json`, 'utf8')); // unchanged
```

**Wiring in a large file (`--split-plan`)** - `worker-ipc/test-merge.js` currently builds its own split fixture
by hand: writes a random file, then calls 7-Zip itself to split it:
```js
const originalPath = path.join(scratchRoot, 'merge-test-source.bin');
fs.writeFileSync(originalPath, crypto.randomBytes(50_000));
const originalHash = sha256(originalPath);

execFileSync(sevenZipPath, ['-v10k', '-mx0', 'a', path.join(tempDir, 'merge-test-source.bin.part'), originalPath]);
const partFilePaths = fs.readdirSync(tempDir)
  .filter((f) => f.startsWith('merge-test-source.bin.part'))
  .sort()
  .map((f) => path.join(tempDir, f));
```
The same result, wired to `generate-tree-from-json.js --split-plan` instead - one call builds the file AND
splits it for real, and the manifest gives you the original hash back without hashing anything yourself:
```js
execFileSync(process.execPath, [
  path.join(__dirname, '../generate-tree-from-json.js'),
  '--spec', path.join(__dirname, '../examples/merge-test-spec.example.json'),       // 2 MiB source file
  '--split-plan', path.join(__dirname, '../examples/merge-test-split-plan.example.json'), // -> 1 MiB volumes
  '--root', scratchRoot,
], { stdio: 'inherit' });

const manifest = JSON.parse(fs.readFileSync(`${scratchRoot}.manifest.json`, 'utf8'));
const originalHash = manifest.files[0].sha256; // recorded under the whole file's path even though only .part files exist on disk
const partFilePaths = fs.readdirSync(scratchRoot)
  .filter((f) => f.startsWith('merge-test-source.bin.part'))
  .sort()
  .map((f) => path.join(scratchRoot, f));
```
Both versions feed `merge-file-parts` the exact same real, 7-Zip-genuine part files - only how they got built
differs. This pair of JSONs is also handy on its own any time you want a quick multi-part split fixture without
a 500MB+ file: `node test-harness/generate-tree-from-json.js --spec test-harness/examples/merge-test-spec.example.json --split-plan test-harness/examples/merge-test-split-plan.example.json`.

### `verify-manifest.js`
```
node test-harness/verify-manifest.js --manifest "<...>.manifest.json" --dir "<recovered folder>"
```
Point this at wherever your recovery ended up. It re-computes every file's fingerprint and compares it against
the manifest, then tells you exactly which files (if any) are `MISSING` (should be there but aren't), `MISMATCH`
(present but content differs — corrupted), or `EXTRA` (present but shouldn't be there). A clean pass means the
recovery is byte-for-byte correct — not just "looks about right." Exits with code 0 (success) or 1 (failure), so
other scripts can check "did this pass?" automatically too.

### `cleanup.js`
```
node test-harness/cleanup.js            # actually removes leftovers
node test-harness/cleanup.js --dry-run  # only reports what it would remove - touches nothing
```
Every script here only cleans up after itself on success — if you interrupt one (Ctrl+C, closing the app window,
or it genuinely fails), it deliberately leaves its scratch data in place so you can inspect it, and that data
just sits there afterward. Run this afterward to clear it out: it wipes `test-harness/generated-fixtures/`
entirely (the shared scratch folder every script here uses — see `lib/fixtures-root.js`; nothing else has any
reason to create a folder at that exact path), and clears the app's real `appData\tempFilesCanBeDeleted\` down to
just its ownership marker (refusing to touch it at all if that marker isn't there). It also reports (but never
touches) any currently mounted optical media, since there's no way to tell a real disc you care about from a
leftover test `.iso`.

Reports mounted media FIRST, before attempting to remove anything — a mounted `.iso` sitting inside the scratch
folder makes Windows refuse to delete it (`EPERM`, the file is locked while mounted). Each top-level scratch item
is removed individually rather than the whole folder in one call, so one locked item is reported clearly and
skipped without blocking everything else from being cleaned up - dismount it yourself
(`Dismount-DiskImage -ImagePath "<path>"`) and re-run to finish the job.

### `lib/` - shared building blocks

Every script above is built out of these - you never run anything in here directly, but it's worth knowing
what each one does, since you'll see them imported (`require('../lib/...')`) at the top of almost every script:

- **`safety.js`** — the containment guard described throughout "Safety model" below: `resolveSafeRoot` (refuses
  dangerous paths), `writeOwnershipMarker`/`hasOwnershipMarker`/`clearMarkedRootContents` (the "did THIS tool
  create this folder?" marker system).
- **`fixtures-root.js`** — one constant, `FIXTURES_ROOT`, pointing at `test-harness/generated-fixtures/`. Every
  script builds its own scratch path under this single shared root, so there's exactly one place to look for
  (or delete) anything any script here has ever generated.
- **`print-tree.js`** — the `printTree(dir, label)` helper behind every "Source tree (before)" / "... (after)"
  listing you'll see printed - a plain indented directory listing with file sizes, for a human to look at.
- **`random-file-writer.js`** — `writeRandomFile(path, sizeBytes)`, used by both generators to fill a file with
  pseudo-random bytes in bounded-size chunks (so a large file's generation doesn't try to hold it all in memory
  at once), printing periodic progress for anything big enough that going silent could look hung.
- **`seven-zip.js`** — `resolveSevenZipExecutablePath()` (reads the real 7-Zip path straight out of
  `appData/config.json`, the same one the app itself uses) and `splitFileIntoRealParts(...)` (runs a REAL
  7-Zip volume split - see `generate-tree-from-json.js`'s own top comment for why it has to be genuinely real,
  not a hand-rolled byte split).
- **`ibb-tools.js`** — everything needed to safely exercise "Send to ImgBurn" without ever launching your real
  ImgBurn: backing up/redirecting `appData/config.json` to a harmless no-op stub, waiting for the real `.ibb`
  file to appear, and parsing its contents back out. See `ui/README.md`'s backup-to-optical-media/add-missing-
  files sections for the full technique.
- **`cold-storage-metadata.js`** — builds a cold-storage metadata JSON fixture from a real disc folder's real
  listing (via the app's own `get-file-paths-with-stats` IPC), matching exactly how the real app itself would
  have saved one - used wherever a test needs to simulate "here's a JSON describing an already-backed-up disc"
  without actually burning one.
- **`fixture-tree-source.js`** — `generateFixtureTree(...)`, the shared random-vs-JSON switch every `ui/`
  script's own source-tree generation step goes through - see `ui/README.md`'s "Switching between random and
  JSON-driven source trees" section for the `--random-tree`/`--json-tree` flags this gives every one of those
  scripts.
- **`startup-dialogs.js`** — `dismissStartupTempClearDialog(win)`, which every `ui/` script (and the two
  `capture-*.js` utilities) calls right after `launchApp()`. Whenever the temp/cache directory actually has
  real leftover content, a real launch shows a modal "Clearing temporary files" dialog before anything else on
  screen is usable (the app has no resume-across-restarts support, so leftover content from an earlier session
  is cleared, with the user told about it first - see `clearTempDataDirectoryOnStartup` in `app.component.ts`;
  if it's already empty, nothing shows at all) - this helper tolerates either outcome, so every script can call
  it unconditionally without knowing in advance whether this particular run has anything to report.

## Safety model (why this can't damage anything real)

- Every script that writes files checks the destination path first (`resolveSafeRoot` in `lib/safety.js`) and
  refuses to touch drive roots, your home folder, Desktop/Documents/Downloads, or system folders — even if you
  accidentally pointed it there.
- `generate-random-tree.js` only ever deletes something (via `--reset`) if that folder already has this script's
  own hidden marker file in it, proving *this script* created it. A real folder that happens to be at the same
  path, but wasn't created by this script, is left completely alone and the script simply refuses to run instead.
- `verify-manifest.js` never writes or deletes anything — it only reads files to compute their fingerprints.
- `optical-media/` only ever creates/mounts/deletes the one exact `.iso` file path you give it, and refuses to
  even start if a real disc (or someone else's mounted `.iso`) is already in a drive — so it can never mix up
  test data with something real. See `ui/README.md`'s pre-run check.
- `worker-ipc/`'s tests refuse to run unless the app's own real temp/cache folder is currently empty (aside from
  its own marker file) — protecting any real, in-progress backup work you might have sitting there.
- Nothing in `test-harness/` changes `src/`/`app/` (the app's actual code) — it only drives and observes it.
- `.gitignore` has rules so none of the throwaway test files/folders these scripts create can ever accidentally
  get committed to your project's history.
- Nothing generated by any script here (fixture trees, `.iso` files, manifests, failure screenshots, error logs
  — everything) is ever written to the OS temp directory, AppData, or anywhere else outside this project. It all
  lands under `test-harness/generated-fixtures/` (see `lib/fixtures-root.js`) — one place to look, one place to
  delete by hand if you ever need to.
- `generate-tree-from-json.js` additionally caps the total declared size of anything it's asked to generate at
  5 GiB, checked BEFORE writing a single byte — a typo'd extra zero in a spec can't silently fill your disk.

## Coverage

All 5 of the app's main-menu features are covered end to end by automated tests — incremental backup,
synchronize directories, recover data (both entry points: physically reading discs, and importing a cold storage
metadata JSON), backup to optical media, and add missing files to cold storage — including their real "Send to
ImgBurn" clicks (safely redirected away from a real ImgBurn launch, never your actual ImgBurn). See
`worker-ipc/README.md` and `ui/README.md` for exactly what each script covers.

## Known limitations

- The automated on-screen recovery test needs a short, deliberate pause to avoid a timing hiccup that only
  happens when clicking through much faster than a human ever would — not something a real person is likely to
  hit; see `ui/README.md`.

## Natural next steps

- **Automating the "add missing files" screen's OTHER entry point** — the "no JSON, physically re-insert every
  existing disc one by one" path, deliberately skipped by `ui/test-add-missing-files.js` since it reuses the same
  `<optical-disc-backup-data-retriever>` component `ui/test-recover-multi-disc.js` already thoroughly exercises.

## How bugs here actually get found

1. Print a line for every single click/step (`done` or `FAILED`), not just a few "checkpoint" messages — this
   pinpoints exactly which click got stuck, instead of a big silent gap.
2. Take a screenshot automatically the moment anything fails — a picture of what the app actually looked like at
   that moment is far faster to diagnose than a written description.
3. Listen in on the app's own existing internal logging (it already logs helpful things to its own developer
   console) instead of guessing — no changes to the app's code needed to see this.
4. When something claims success but nothing visibly happened, grab a screenshot *during* the operation, not
   just after — to catch the app's own live progress display in the act, rather than guessing what it was doing
   internally.
