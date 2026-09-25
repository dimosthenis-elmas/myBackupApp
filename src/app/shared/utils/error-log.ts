export type ErrorSource = 'main' | 'worker' | 'renderer';

/** A console.error call split into what the user sees (summary) and what only logs.txt and an optional
 *  "technical details" expansion need (details) - see splitErrorArgs. Mirrors app/logging.ts's identical type,
 *  kept as a separate copy here rather than shared: the renderer builds via webpack/Angular, not tsc, and has
 *  no fs access anyway (everything here goes through IPC instead), so there is nothing meaningful for the two
 *  to share beyond this shape and the couple of small functions below. */
export interface ReportedError {
  summary: string;
  details: string;
  /** Optional dialog title in place of the default for its source (see ErrorReporterService's SOURCE_LABELS). */
  title?: string;
  /** Optional lists of items (e.g. file paths) shown as scrollable lists below the summary - see
   *  ConfirmationDialogComponent's `lists`. */
  lists?: Array<{ label: string, items: string[] }>;
}

type DialogHandler = (source: ErrorSource, reported: ReportedError) => void;

/** Set once by ErrorReporterService's constructor (a root-provided singleton, forced to instantiate early via
 *  AppComponent's own constructor - see that service's own comment). Errors reported before that has happened
 *  (there is a real window for this: this module's console.error wrapper is installed in src/main.ts before
 *  bootstrapModule() even starts) are queued in pendingDialogs and flushed the moment it registers, rather than
 *  lost. */
let dialogHandler: DialogHandler | null = null;
let pendingDialogs: Array<{ source: ErrorSource; reported: ReportedError }> = [];

function electronAPI(): any {
  return (window as any).electronAPI;
}

export function formatLogArg(arg: unknown): string {
  if (arg instanceof Error) { return arg.stack || arg.message; }
  if (typeof arg === 'string') { return arg; }
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

/** Splits a console.error call's arguments into a plain-language summary and technical details - see
 *  app/logging.ts's identical function for the full rationale (same convention, same reasoning): leading string
 *  arguments are the human-written explanation, everything from the first non-string argument onward is
 *  supporting technical detail for a developer, not something to show the user as "the explanation". Falls back
 *  to a generic summary if there were no leading string arguments at all. */
export function splitErrorArgs(args: unknown[]): ReportedError {
  const summaryParts: string[] = [];
  const detailParts: string[] = [];
  let sawNonString = false;
  for (const arg of args) {
    if (typeof arg === 'string' && !sawNonString) {
      summaryParts.push(arg);
    } else {
      sawNonString = true;
      detailParts.push(formatLogArg(arg));
    }
  }
  return {
    summary: summaryParts.length > 0 ? summaryParts.join(' ') : 'Something unexpected went wrong in the app.',
    details: detailParts.join('\n')
  };
}

/** Ships one already-formatted line to the main process, which appends it to logs.txt - the renderer has no
 *  direct fs access (contextIsolation), so this is the only way its own log lines reach that file. Best-effort
 *  and silent on failure (including simply running outside Electron, e.g. in a browser or a unit test): logging
 *  must never be able to throw or block whatever called it. */
export function appendLogLine(level: 'LOG' | 'WARN' | 'ERROR', message: string): void {
  const api = electronAPI();
  if (!api || typeof api.ipcRenderer_send !== 'function') { return; }
  try {
    api.ipcRenderer_send('append-log', `${new Date().toISOString()} [renderer] ${level} ${message}`);
  } catch {
    // no-op - see the comment above.
  }
}

function queueOrShowDialog(source: ErrorSource, reported: ReportedError): void {
  if (dialogHandler) {
    dialogHandler(source, reported);
  } else {
    pendingDialogs.push({ source, reported });
  }
}

/** For errors that occur in the renderer itself - the console.error wrapper installed in src/main.ts, and
 *  GlobalErrorHandler for anything Angular catches as an uncaught exception/rejection. Shows the dialog (logging
 *  to logs.txt is the caller's own job via appendLogLine, same as for LOG/WARN - see src/main.ts). */
export function reportRendererError(reported: ReportedError): void {
  queueOrShowDialog('renderer', reported);
}

/** For errors relayed from the main/worker processes over the 'app-error' IPC channel (see main.ts and
 *  worker.ts's own console.error wrappers) - those already appended their line to logs.txt at the source. */
export function showRelayedError(source: ErrorSource, reported: ReportedError): void {
  queueOrShowDialog(source, reported);
}

/** Registers the function that actually opens the error dialog, and immediately flushes anything reported
 *  before it was ready (see pendingDialogs' own comment). */
export function registerErrorDialogHandler(fn: DialogHandler): void {
  dialogHandler = fn;
  const queued = pendingDialogs;
  pendingDialogs = [];
  queued.forEach(({ source, reported }) => fn(source, reported));
}
