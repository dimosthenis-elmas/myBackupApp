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

  ngOnInit(): void {
   
  }

  closeDialog(){
    this.dialogRef.close()
  }

}
