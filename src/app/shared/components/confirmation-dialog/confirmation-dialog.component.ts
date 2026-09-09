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

  ngOnInit(): void {
   
  }

  closeDialog(){
    this.dialogRef.close()
  }

}
