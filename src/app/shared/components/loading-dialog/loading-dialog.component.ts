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

  ngOnInit(): void {
  }

}
