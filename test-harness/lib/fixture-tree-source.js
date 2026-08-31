'use strict';

/**
 * Shared "which generator should build this test's source tree" switch, used by every ui/test-*.js script.
 * Every one of those scripts used to hardcode a single execFileSync call to generate-random-tree.js with its own
 * fixed args - this lets the SAME script instead build its tree from this test's own bundled JSON spec
 * (generate-tree-from-json.js), via a command-line flag, without changing anything downstream: both generators
 * produce the identical manifest.json shape, so whatever the calling script does next (read the manifest, print
 * the tree, feed it to the app) is completely unaware of which one actually ran.
 *
 * Flags (recognized by every ui/test-*.js script):
 *   --random-tree   Generate a random tree (generate-random-tree.js). This is the default - passing no flag at
 *                   all behaves exactly as before.
 *   --json-tree     Generate from this script's own spec instead - see specDir below: each script has its own
 *                   tree-spec.json (and, if it needs one, split-plan.json) under
 *                   test-harness/ui/tree-specs/<script-name>/. There is no separate "point at some other file"
 *                   flag on purpose - that file is a real, plain JSON file meant to be edited in place for your
 *                   own scenarios, not just a read-only sample.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

/** Parses just the fixture-source flag out of an argv array (extra/unrelated flags are ignored - each script
 *  still parses its own args separately, if it has any). */
function parseFixtureSourceArgs(argv) {
  let mode = 'random';
  for (const arg of argv) {
    if (arg === '--random-tree') { mode = 'random'; }
    else if (arg === '--json-tree') { mode = 'json'; }
  }
  return { mode };
}

/** Builds the source tree at `root`, using either generator depending on the command line (see the flags
 *  documented above). `randomArgs` is the exact flag list this script has always passed to
 *  generate-random-tree.js (unchanged, only used in random mode). `specDir` is this script's own
 *  `test-harness/ui/tree-specs/<script-name>/` folder - `--json-tree` always reads `tree-spec.json` (and
 *  `split-plan.json`, if present) straight out of there, so editing that file in place is all you need to do to
 *  run this script against your own scenario.
 * @return the mode that was actually used ('random' or 'json') - most callers don't need this (both generators
 *   leave the exact same manifest.json shape behind), but it's returned in case a caller wants to log it. */
function generateFixtureTree({ root, randomArgs, specDir, argv = process.argv.slice(2) }) {
  const { mode } = parseFixtureSourceArgs(argv);

  if (mode === 'json') {
    const specPath = path.join(specDir, 'tree-spec.json');
    const splitPlanPath = path.join(specDir, 'split-plan.json');
    const hasSplitPlan = fs.existsSync(splitPlanPath);
    if (!fs.existsSync(specPath)) {
      throw new Error(`--json-tree: no tree-spec.json found under "${specDir}"`);
    }
    console.log(`Generating test source tree at ${root} from JSON spec (${specPath})` +
      (hasSplitPlan ? ` + split plan (${splitPlanPath})` : '') + ' ...');
    const args = [path.join(__dirname, '../generate-tree-from-json.js'), '--spec', specPath, '--root', root];
    if (hasSplitPlan) { args.push('--split-plan', splitPlanPath); }
    execFileSync(process.execPath, args, { stdio: 'inherit' });
  } else {
    console.log(`Generating test source tree at ${root} (random) ...`);
    execFileSync(process.execPath, [
      path.join(__dirname, '../generate-random-tree.js'),
      '--root', root,
      ...randomArgs,
    ], { stdio: 'inherit' });
  }

  return mode;
}

module.exports = { generateFixtureTree, parseFixtureSourceArgs };
