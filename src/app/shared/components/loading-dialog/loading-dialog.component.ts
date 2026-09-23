import { Component, OnInit } from '@angular/core';

@Component({
  selector: 'app-loading-dialog',
  templateUrl: './loading-dialog.component.html',
  styleUrls: ['./loading-dialog.component.css']
})
export class LoadingDialogComponent implements OnInit {

  constructor() { }

  showCancelButton=true;
  /** Optional static heading shown in place of the default "Please wait" (e.g. "Calculating SHA-256 hashes") -
   *  callers set this once per operation, not on every progress tick: reassigning it every time a new line
   *  arrives would replace this whole heading's text over and over (potentially hundreds of times for a large
   *  batch) instead of just a number changing in place. A live count belongs in `detail`/`progressCurrent`/
   *  `progressTotal` below. Left undefined, every existing caller keeps showing plain "Please wait", unchanged. */
  message?: string;

  /** Optional line shown below `message` for content that genuinely changes with each item - e.g. the path of
   *  the file currently being hashed - as opposed to a counter (see `progressCurrent`/`progressTotal`), which
   *  should be bound as its own number rather than folded into this text. Left undefined, nothing is shown. */
  detail?: string;

  /** Optional live counter shown as "`progressCurrent` of `progressTotal`" below `message`/`detail` - e.g.
   *  "3 of 42" while computeSha256ForBackedUpFiles hashes each file, or while a directory scan progresses
   *  against its own upfront-probed total (see countAllFilesQuick, worker.ts). Always set together - bound as
   *  plain numbers (see progress-line.ts's parseProgressFromLine/parseScanItemsProgress) so the template only
   *  ever re-renders the numbers themselves, never the surrounding words. Left undefined, no counter is shown. */
  progressCurrent?: number;
  progressTotal?: number;

  /** Optional percentage (0-100) for callers that want the same circular spinner shown in a real determinate
   *  mode (a filling ring) instead of its plain indeterminate spin - e.g. a directory-comparison phase reporting
   *  "(i of N) items compared" text that the caller has already parsed into a plain number (see
   *  parseProgressFromLine, shared/utils), or a per-file hashing loop reporting a running count against a known
   *  total. Left undefined, the dialog shows the plain indeterminate spinner exactly as before - this is purely
   *  additive. */
  percent?: number;

  /** What the template actually binds the determinate mat-progress-spinner's `[value]` to - `percent` when a
   *  caller set it, otherwise undefined (plain indeterminate mat-spinner, unchanged default behavior). */
  get progressPercent(): number | undefined {
    return this.percent;
  }

  ngOnInit(): void {
  }

}
