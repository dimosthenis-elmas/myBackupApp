import { Component, OnInit } from '@angular/core';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';

@Component({
  selector: 'app-confirmation-dialog',
  templateUrl: './confirmation-dialog.component.html',
  styleUrls: ['./confirmation-dialog.component.css']
})
export class ConfirmationDialogComponent implements OnInit {

  constructor(public dialog: MatDialog, private dialogRef: MatDialogRef<ConfirmationDialogComponent>) { }
  public title = "No title provided"
  public message = "No message provided .."
  public actionsNum = 1;
  public action1Label = "Ok"
  public action2Label = "action 2"
  public action1=false;
  public action2=false;
  public action1Callback: () => any = ()=>{this.dialogRef.close()};
  public action2Callback!: () => any;
  /** Optional named file-list sections (e.g. {label: "FAILED (3)", items: [...]}) rendered below `message` as
   *  real virtualized scrolling lists (cdk-virtual-scroll-viewport) - for callers that need to show
   *  potentially many file names (e.g. an integrity-check result) without cramming a truncated "first 15, and
   *  N more" string into `message`. Callers should omit a section entirely rather than include one with an
   *  empty `items` array. Left undefined, every existing caller keeps showing plain message-only text,
   *  unchanged. */
  public lists?: Array<{ label: string, items: string[] }>;
  /** Optional raw technical detail (a stack trace, a raw process dump, ...) for an error dialog - see
   *  ErrorReporterService. Rendered collapsed by default below `message`: the user should read a plain-language
   *  explanation first, with the technical detail available on request rather than presented as "the message". */
  public technicalDetails?: string;
  /** Optional single checkbox rendered below the lists, defaulting to unchecked (e.g. "Delete all the
   *  recovered files which did not pass the verification test."). Left undefined, no checkbox is rendered. The
   *  caller reads `checkboxChecked` from its own action callback (it closes over this dialog's
   *  componentInstance) to decide what to do - this component itself has no opinion on what the checkbox
   *  means. */
  public checkboxLabel?: string;
  public checkboxChecked = false;

  ngOnInit(): void {
   
  }

  closeDialog(){
    this.dialogRef.close()
  }

}
