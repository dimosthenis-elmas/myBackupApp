import * as fs from 'fs';
import * as path from 'path';

/** Once logs.txt exceeds this, rotateAndWriteSessionHeader below moves it to logs.txt.old (overwriting any
 *  previous one) and starts fresh - keeps at most ~2x this on disk (current + one previous rotation). Simple and
 *  bounded rather than unbounded growth or a more elaborate multi-generation scheme this single-user app has no
 *  real need for. */
const MAX_LOG_FILE_SIZE_BYTES = 5 * 1024 * 1024;

export type LogLevel = 'LOG' | 'WARN' | 'ERROR';

/** A console.error call split into what the user sees (summary) and what only logs.txt and an optional
 *  "technical details" expansion need (details) - see splitErrorArgs. */
export interface ReportedError {
  summary: string;
  details: string;
}

export function formatLogArg(arg: any): string {
  if (arg instanceof Error) { return arg.stack || arg.message; }
  if (typeof arg === 'string') { return arg; }
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

/** Splits a console.error call's arguments into a plain-language summary and technical details, by the
 *  convention already used at every existing console.error call site in this codebase: leading string
 *  arguments are the human-written explanation ("Failed to parse optical disc detection output"), arguments
 *  from the first non-string one onward (an Error object, a raw stdout dump, ...) are supporting technical
 *  detail meant for a developer, not the message a user should be asked to read and understand. Falls back to
 *  `fallbackSummary` when there were no leading string arguments at all (e.g. a bare `console.error(err)`) - the
 *  user should never be shown nothing, or a raw stack trace, as "the explanation". */
export function splitErrorArgs(args: any[], fallbackSummary: string): ReportedError {
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
    summary: summaryParts.length > 0 ? summaryParts.join(' ') : fallbackSummary,
    details: detailParts.join('\n')
  };
}

/** Appends one already-formatted line to `logFilePath`, creating its directory first if needed. Swallows its
 *  own failures rather than throwing or logging them - callers use this from inside a console.error wrapper, so
 *  anything this did that itself called console.error would recurse forever. */
export function appendToLogFile(logFilePath: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, line + '\n');
  } catch {
    // Logging must never be able to crash or block the app - if this fails there is nowhere left to report it.
  }
}

/** Called once, at startup, by whichever process owns writing the session header (main.ts) - rotates logs.txt
 *  (see MAX_LOG_FILE_SIZE_BYTES) if needed, then writes a fresh "======== <timestamp> ========" header. Marks
 *  the start of this launch - logs.txt otherwise just keeps growing across launches, so this is what lets a
 *  shared, continuously-growing file still be read as a sequence of distinct sessions. */
export function rotateAndWriteSessionHeader(logFilePath: string): void {
  try {
    const stat = fs.statSync(logFilePath);
    if (stat.size > MAX_LOG_FILE_SIZE_BYTES) {
      fs.copyFileSync(logFilePath, logFilePath + '.old');
      fs.truncateSync(logFilePath, 0);
    }
  } catch {
    // ENOENT (no logs.txt yet - e.g. first launch) is expected here, not a failure - nothing to rotate.
  }
  appendToLogFile(logFilePath, `\n======== ${new Date().toISOString()} ========`);
}

/** Installs console.log/warn/error wrapping for the current process: every level is appended to logFilePath in
 *  full technical detail (tagged with `processTag`), and console.error additionally calls `onError` with a
 *  user-facing summary/details split (see splitErrorArgs) - main.ts forwards it to the renderer to show as a
 *  dialog, worker.ts ships it to main over the 'app-error' IPC channel (see each file's own onError).
 *
 *  error vs warn is a real severity call at each call site (see both files' own comments on this), not a
 *  stylistic choice - only error interrupts the user, so something recoverable/expected/already-surfaced some
 *  other way belongs at warn. */
export function installConsoleLogging(
  processTag: string,
  logFilePath: string,
  fallbackSummary: string,
  onError: (reported: ReportedError) => void
): void {
  const original = { log: console.log, warn: console.warn, error: console.error };

  function wrap(level: LogLevel, fn: (...args: any[]) => void) {
    return (...args: any[]) => {
      fn.apply(console, args);
      appendToLogFile(logFilePath, `${new Date().toISOString()} [${processTag}] ${level} ${args.map(formatLogArg).join(' ')}`);
      if (level === 'ERROR') {
        onError(splitErrorArgs(args, fallbackSummary));
      }
    };
  }

  console.log = wrap('LOG', original.log);
  console.warn = wrap('WARN', original.warn);
  console.error = wrap('ERROR', original.error);
}
