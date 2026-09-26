'use strict';

/**
 * Builds a real .iso from an .ibb project the app wrote, with the real ImgBurn - no disc, no prompts:
 *   ImgBurn.exe /MODE BUILD /SRC <ibb> /DEST <iso> /OUTPUTMODE IMAGEFILE /START /CLOSE /NOIMAGEDETAILS /LOG <log>
 * For checking what ImgBurn really puts on a disc (names, folders) - which the tests that click "Send to ImgBurn"
 * against a no-op stub never see. ImgBurn opens its window for a few seconds while it builds.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

/** The ImgBurn configured in `configContent` (appData/config.json's raw text, read before any test redirects it) -
 *  throws if it is not there: a real build needs the real ImgBurn. */
function realImgBurnPath(configContent) {
  const exe = JSON.parse(configContent).imgBurnExecutablePath;
  if (!exe || !fs.existsSync(exe)) {
    throw new Error(`This test builds a real disc image with ImgBurn, but imgBurnExecutablePath in appData/config.json ("${exe}") does not exist.`);
  }
  return exe;
}

/** Builds `isoPath` from `ibbPath` with ImgBurn at `imgBurnExe`, writing its log to `logPath`. Returns the log's
 *  warning and error lines ("W ..."/"E ...") - ImgBurn's only word on a name it had to change - and whether the
 *  image was written. */
function buildIsoWithImgBurn(imgBurnExe, ibbPath, isoPath, logPath) {
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const args = `/MODE BUILD /SRC "${ibbPath}" /DEST "${isoPath}" /OUTPUTMODE IMAGEFILE /START /CLOSE /NOIMAGEDETAILS /LOG "${logPath}"`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Start-Process -FilePath ${q(imgBurnExe)} -ArgumentList ${q(args)} -PassThru; ` +
    `if (-not $p.WaitForExit(180000)) { $p.Kill(); throw 'ImgBurn did not finish within 3 minutes (waiting on a prompt?)' }`,
  ], { stdio: 'pipe' });
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf16le').replace(/^﻿/, '') : '';
  return {
    built: fs.existsSync(isoPath) && fs.statSync(isoPath).size > 0,
    problems: log.split(/\r?\n/).filter((line) => /^[WE] \d/.test(line)),
  };
}

module.exports = { realImgBurnPath, buildIsoWithImgBurn };
