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
  /** Real percentage (0-100) for the preview phase this dialog covers - see updateProgress() below, called
   *  from sync-dirs.component.ts's previewOperationsBeforeCommiting as "(i of N)" progress markers arrive. */
  percentComplete = 0;
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

  /** Updates the real percentage shown while workFinished_ is still false - see percentComplete's own doc
   *  comment. The one way callers should drive this dialog's progress bar. */
  updateProgress(percent: number): void {
    this.percentComplete = percent;
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
