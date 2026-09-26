/** What a backup wizard says about the links its scan left out - `count` of them, from the scan's response (see
 *  WorkerResponse.linksLeftOut) - in a dialog it already shows before copying or burning anything; "" when there were
 *  none. Each link is named, with where it points, in logs.txt only (see leaveOutLink in app/workers/worker.ts), not
 *  in the "Some items were left out" warning, which would otherwise show Windows' own links on every run. */
export function linksLeftOutNote(count: number | undefined): string {
  if (!count) { return ''; }
  const links = count === 1 ? '1 link (a symbolic link or junction) was' : `${count} links (symbolic links and junctions) were`;
  return `${links} left out: links are not backed up - neither the link nor what it points to. ` +
    `Each one, with where it points, is listed in logs.txt, in the app's appData folder.`;
}

/** `message`, followed by linksLeftOutNote(count) as a paragraph of its own when there is one. */
export function withLinksLeftOutNote(message: string, count: number | undefined): string {
  const note = linksLeftOutNote(count);
  return note ? `${message}\n\n${note}` : message;
}
