import { Component, OnInit, ViewChild } from '@angular/core';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

@Component({
  selector: 'app-loading-dialog',
  templateUrl: './loading-dialog.component.html',
  styleUrls: ['./loading-dialog.component.css']
})
export class LoadingDialogComponent implements OnInit {

  constructor() { }

  showCancelButton=true;
  /** Optional progress text shown in place of the default "Please wait" (e.g. "Calculating SHA-256 for file:
   *  ... (3 of 42 files)") - callers driving a long-running worker operation update this directly as progress
   *  pushes arrive, rather than this dialog knowing anything about any specific operation. Left undefined,
   *  every existing caller keeps showing plain "Please wait", unchanged. Ignored once `lines` is used instead
   *  (see below) - the two are alternatives, not combined. */
  message?: string;
  /** Optional accumulating list of progress lines (e.g. "Calculating SHA-256 for file: ... (3 of 42 files)"),
   *  shown as a REAL virtualized scrolling list (cdk-virtual-scroll-viewport, same primitive
   *  ScrollableListComponent itself is built on) in place of the plain spinner - for callers driving a
   *  long-running, many-step operation where seeing the whole history is actually useful, rather than
   *  overwriting `message` and discarding everything but the current line. Left undefined, every existing
   *  caller keeps showing the plain spinner+message, unchanged.
   *
   *  Deliberately NOT capped/truncated - a virtual scroll viewport only ever renders the rows actually visible
   *  on screen into the real DOM, however many thousands of lines `lines` itself holds, so there is no
   *  DOM-node-count blowup to cap against in the first place (unlike a plain *ngFor over the whole array, which
   *  is what an earlier version of this used to do, and which really would have gotten progressively slower as
   *  the list grew). The array itself holding many thousands of short strings is not a real memory concern
   *  either - each one is at most a couple hundred bytes.
   *
   *  Also deliberately each dialog INSTANCE's own local array, not a subscription to some shared stream: unlike
   *  ScrollableListComponent (tied to BackupService's single app-wide previewLogsStream, meant for one
   *  full-screen operation at a time), a caller here just pushes new lines directly onto this array via
   *  pushLines() - so two genuinely concurrent operations, each with their own LoadingDialogComponent instance
   *  (e.g. two discs' SHA-256 hashing sent to ImgBurn at the same time - see attachSha256HashesToDiscFiles),
   *  can never cross-contaminate each other's progress lines, which a shared stream would. */
  lines?: string[];

  /** Optional known total item count for whatever `lines` is accumulating one line per - set this alongside
   *  `lines` when the caller already knows the total up front (e.g. hashableEntries.length before SHA-256
   *  hashing starts) to turn the plain spinner into a real determinate `mat-progress-bar` (see `progressPercent`
   *  below), reflecting `lines.length / total`. Left undefined, the dialog shows the plain spinner exactly as
   *  before - this is purely additive. */
  total?: number;

  /** Optional percentage (0-100) for callers that want a real determinate bar WITHOUT the scrolling `lines`
   *  list itself - e.g. a directory-comparison phase reporting "(i of N) items compared" text via `message`
   *  that the caller has already parsed into a plain number (see parseProgressFromLine, shared/utils). Takes
   *  priority over the `lines`/`total` computation below when both are somehow set. */
  percent?: number;

  /** What the template actually binds the determinate bar's `[value]` to - `percent` when a caller set it
   *  directly, otherwise derived from `lines.length`/`total` when both are set, otherwise undefined (plain
   *  spinner, unchanged default behavior). */
  get progressPercent(): number | undefined {
    if (this.percent !== undefined) { return this.percent; }
    if (this.lines && this.total !== undefined) {
      // total === 0 means there was nothing to do (e.g. a disc with no files carrying a recorded hash to
      // verify) - report 100 rather than falling through to `undefined`, which would show the plain spinner
      // AND the (empty) scrolling lines list at the same time instead of one clean "done" state.
      return this.total === 0 ? 100 : Math.min(100, Math.round((this.lines.length / this.total) * 100));
    }
    return undefined;
  }

  @ViewChild(CdkVirtualScrollViewport) private viewport?: CdkVirtualScrollViewport;

  /** Appends `newLines` to `lines` (creating it if this is the first call) and scrolls the virtual viewport to
   *  the new last line. The one way callers should add progress lines to this dialog. */
  pushLines(newLines: string[]): void {
    if (!this.lines) { this.lines = []; }
    this.lines.push(...newLines);
    // The viewport doesn't exist yet on the very first push (the *ngIf="lines" branch of the template hasn't
    // rendered until Angular's next change-detection pass) - scrollToIndex on the NEXT push still catches it
    // up correctly, so skipping silently here (rather than queuing a retry) is fine.
    if (this.viewport) {
      this.viewport.scrollToIndex(this.lines.length - 1);
    }
  }

  ngOnInit(): void {
  }

}
