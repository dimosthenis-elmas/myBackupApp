import { Component, OnInit } from '@angular/core';

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
   *  every existing caller keeps showing plain "Please wait", unchanged. */
  message?: string;

  /** Optional percentage (0-100) for callers that want a real determinate bar instead of the plain spinner -
   *  e.g. a directory-comparison phase reporting "(i of N) items compared" text via `message` that the caller
   *  has already parsed into a plain number (see parseProgressFromLine, shared/utils), or a per-file hashing
   *  loop reporting a running count against a known total. Left undefined, the dialog shows the plain spinner
   *  exactly as before - this is purely additive. */
  percent?: number;

  /** What the template actually binds the determinate bar's `[value]` to - `percent` when a caller set it,
   *  otherwise undefined (plain spinner, unchanged default behavior). */
  get progressPercent(): number | undefined {
    return this.percent;
  }

  ngOnInit(): void {
  }

}
