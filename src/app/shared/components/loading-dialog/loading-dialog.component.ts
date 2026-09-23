import { Component, OnInit } from '@angular/core';

@Component({
  selector: 'app-loading-dialog',
  templateUrl: './loading-dialog.component.html',
  styleUrls: ['./loading-dialog.component.css']
})
export class LoadingDialogComponent implements OnInit {

  constructor() { }

  showCancelButton=true;
  /** Optional heading shown above the spinner in place of the default "Please wait" (e.g. "Calculating SHA-256
   *  hashes") - always visible, whether the spinner is indeterminate or filling, so the user can tell what the
   *  dialog is doing. Set it once per operation; never put a running count in it. */
  message?: string;

  /** Optional percentage (0-100) for callers that want the same circular spinner shown in a real determinate
   *  mode (a filling ring, with no counter or other numbers next to it) instead of its plain indeterminate
   *  spin - e.g. a directory-comparison phase reporting "(i of N) items compared" text that the caller has
   *  already parsed into a plain number (see parseProgressFromLine, shared/utils), or a per-file hashing loop
   *  reporting a running count against a known total. Left undefined, the dialog shows the plain indeterminate
   *  spinner exactly as before - this is purely additive. */
  percent?: number;

  /** What the template actually binds the determinate mat-progress-spinner's `[value]` to - `percent` when a
   *  caller set it, otherwise undefined (plain indeterminate mat-spinner, unchanged default behavior). */
  get progressPercent(): number | undefined {
    return this.percent;
  }

  ngOnInit(): void {
  }

}
