/** The heads-up every backup wizard gives about links, once, in a dialog it already shows before copying or burning
 *  anything - rather than listing each link left out in the "Some items were left out" warning on every run (see
 *  leaveOutLink in app/workers/worker.ts, which writes each one to logs.txt instead). */
export const LINKS_NOT_BACKED_UP_NOTE =
  'Links (symbolic links and junctions) are not backed up - neither the link nor what it points to. ' +
  'Each one left out, with where it points, is listed in logs.txt, in the app\'s appData folder.';
