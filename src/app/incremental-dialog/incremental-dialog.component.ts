import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { ScrollableListComponent } from '../scrollable-list/scrollable-list.component';
import { CollectionViewer } from '@angular/cdk/collections';

@Component({
  selector: 'app-incremental-dialog',
  templateUrl: './incremental-dialog.component.html',
  styleUrls: ['./incremental-dialog.component.css']
})
export class IncrementalDialogComponent implements OnInit {
  
  @ViewChild('scrollMe')
  private myScrollContainer!: ElementRef;

  showProgressBar_=false;
  workIsInProgess_=true;
  workFinished_=false;
  proceed_message='Write to the backup';
  proceedBtnIsDisabled=false;
  scrollableLogsListRef!: ScrollableListComponent;

  constructor() { }

   @ViewChild(ScrollableListComponent)  set scrollableLogsList(v: ScrollableListComponent) {
      setTimeout(() => {
        this.scrollableLogsListRef = v;
      }, 0);
    }
  
  ngOnInit() { 
    this.scrollToBottom();
  }

  ngAfterViewChecked() {        
      this.scrollToBottom();        
  } 

  scrollToBottom(): void {
      try {
          this.myScrollContainer.nativeElement.scrollTop = this.myScrollContainer.nativeElement.scrollHeight;
      } catch(err) { }                 
  }
  
  ngOnDestroy(): void {}

  showProgressBar():void{
    this.showProgressBar_=true;
  }

  progessBarCompleted():void{
    this.workFinished_=true;
    this.workIsInProgess_=false;
  }

  enableProceedBtn():void{
    this.proceedBtnIsDisabled=false;
  }

  disableProceedBtn():void{
    this.proceedBtnIsDisabled=true;
  }

  getNumOfLogs():number{
    return this.scrollableLogsListRef.dataSource.totalLogsCount;
  }

  restartConnection():void{
    this.scrollableLogsListRef.dataSource.connect(this.scrollableLogsListRef.vrlist);
  }

  streamFinishedPromise():Promise<void>{
    return this.scrollableLogsListRef.dataSource.streamFinishedPromise();
  } 


}
