'use strict';

/**
 * Thin Node wrapper around test-harness/optical-media/OpticalMediaTestKit.psm1 (build/mount/dismount a test
 * .iso) for use from a UI-automation test script. See that module for the full safety notes - this just spawns
 * PowerShell to call it and parses the result.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '../optical-media/OpticalMediaTestKit.psm1');

function runPS(script) {
  // -ExecutionPolicy Bypass scopes the override to just THIS spawned process - it does not change the user's
  // persistent system/user-wide execution policy at all (nothing here calls Set-ExecutionPolicy). Needed
  // because Import-Module on a .psm1 FILE is treated as "running a script from a file" and is blocked by the
  // default Windows execution policy (Restricted) even for a script you wrote yourself - inline -Command
  // strings alone (used everywhere else while building this) aren't affected by that policy, which is why this
  // didn't surface until OpticalMediaTestKit.psm1 was actually Import-Module'd from a real user terminal.
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
}

/** Throws if Windows currently reports ANY optical drive with media loaded (real or already-mounted test ISO) -
 *  run BEFORE mounting a test disc. Without this, a real disc/ISO already in a drive could get picked up by the
 *  app's own detection instead of (or racing) the one this test just mounted, silently corrupting the test's
 *  result rather than failing loudly. Mirrors temp-dir-guard.js's "fail closed on ambiguous pre-existing state"
 *  approach.
 *
 *  Filters on Size -gt 0, exactly like the app's own OPTICAL_DISC_POLL_SCRIPT (see worker.ts) - DriveType=5
 *  alone also matches an empty physical optical drive with no disc in it at all (Size/VolumeName both null in
 *  that case), which is not something to refuse on - only actual loaded media is. First run against this
 *  exact machine hit that: an empty D: drive letter was wrongly flagged before this filter was added. */
function assertNoOpticalMediaAlreadyMounted() {
  const out = runPS(
    `Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=5" | Where-Object { $_.Size -gt 0 } | ` +
    `Select-Object DeviceID, VolumeName, Size | ConvertTo-Json -Compress`
  );
  const trimmed = out.trim();
  if (trimmed) {
    throw new Error(
      `Refusing to run: Windows already reports an optical drive with media loaded (${trimmed}). ` +
      `This could be a real disc or an ISO left mounted from a previous run. Eject/dismount it first ` +
      `(Dismount-DiskImage, or just eject the real disc), then re-run.`
    );
  }
}

function buildIso(sourceDir, isoPath, volumeName) {
  runPS(`
    $ErrorActionPreference = 'Stop'
    Import-Module "${MODULE_PATH}" -Force
    New-TestIso -SourceDir "${sourceDir}" -IsoPath "${isoPath}" -VolumeName "${volumeName}" | Out-Null
  `);
}

function mountIso(isoPath) {
  const out = runPS(`
    $ErrorActionPreference = 'Stop'
    Import-Module "${MODULE_PATH}" -Force
    (Mount-TestIso -IsoPath "${isoPath}") | ConvertTo-Json -Compress
  `);
  const jsonLine = out.trim().split(/\r?\n/).filter(Boolean).pop();
  return JSON.parse(jsonLine);
}

function dismountIso(isoPath) {
  runPS(`
    $ErrorActionPreference = 'Stop'
    Import-Module "${MODULE_PATH}" -Force
    Dismount-TestIso -IsoPath "${isoPath}"
  `);
}

module.exports = { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso };
