import { ElementRef, NgZone, OnDestroy, ViewChild } from '@angular/core';
import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { WorkerCommunicator as ipc, WorkerCommunicator } from '../../../app/workers/worker-communicator'
import { BackupService } from '../core/services/backup/backup.service';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmationDialogComponent } from '../shared/components/confirmation-dialog/confirmation-dialog.component';
import { WorkerListener, WorkerResponse } from '../../../app/workers/ipc.interfaces';

@Component({
  selector: 'app-incremental-copying',
  templateUrl: './incremental-copying.component.html',
  styleUrls: ['./incremental-copying.component.css']
})
export class IncrementalCopyingComponent implements OnInit, OnDestroy {
  public panelOpenState = true;
  public selectedFiles: Array<string>;
  public finished = false;
  public copyingPromise!: Promise<WorkerResponse>;
  private workerListener!: WorkerListener;
  public errorOccured = false;

  @ViewChild('scrollMe')
  private myScrollContainer!: ElementRef;

  constructor(public router: Router, private route: ActivatedRoute, public backup: BackupService, public ngZone: NgZone, public dialog: MatDialog) {
    // @ts-ignore
    this.selectedFiles = this.router.getCurrentNavigation().extras.state.selectedFiles;
   }


  
  ngOnInit() {
    this.backup.resetStream();
    this.workerListener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        //console.log(arg);
        switch (response.key) {
          case 'incremental-copy-files':
            if(response.status == 'running'){
              this.backup.previewLogsStream.next(response.res);
            }else if(response.status == 'completed' || response.status == 'stopped'){
              this.backup.previewLogsStream.complete();
            }            
            break;
          default:
            console.error('Got unknown message from ipcMain.')
            break;
        }
      });
    });
  }

  ngOnDestroy():void {
    ipc.onDestroy();
  }

  ngAfterViewInit() {
    this.copyingPromise = ipc.incrementalCopyFiles(this.selectedFiles, this.backup.sourcePath, this.backup.targetPath)
    
    this.copyingPromise.catch((err)=>{
      this.onError(err);
    });

    this.copyingPromise.then((res) => {
      this.finished = true;
      if (res.status == 'completed') {
        this.dialog.closeAll();
        const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
        loadingDialogRef.componentInstance.message =
          `The files have been copied successfully`;
        loadingDialogRef.componentInstance.title = "Copy"
      }else if(res.status == 'stopped'){
        this.dialog.closeAll();
        const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
        loadingDialogRef.componentInstance.message =
          `Copying to backup has stopped.`;
        loadingDialogRef.componentInstance.title = "Copy"

      }
    })
  }

  ngAfterViewChecked() {
    this.scrollToBottom();
  }

  scrollToBottom(): void {
    try {
      this.myScrollContainer.nativeElement.scrollTop = this.myScrollContainer.nativeElement.scrollHeight;
    } catch (err) { }
  }

  onError(err: any) {
    this.errorOccured = true;
    this.dialog.closeAll();
    this.workerListener.removeListener();
    const confirmCopyDialog = this.dialog.open(ConfirmationDialogComponent);
    confirmCopyDialog.componentInstance.message = err;
    confirmCopyDialog.componentInstance.title = "Error"
    confirmCopyDialog.componentInstance.actionsNum = 1;
    confirmCopyDialog.componentInstance.action1Label = "Ok"
    confirmCopyDialog.componentInstance.action1Callback = () => { confirmCopyDialog.close() }
  }

  cancel() {
    const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
      loadingDialogRef.componentInstance.message =
        `Are you sure you want to stop the process?`;
      loadingDialogRef.componentInstance.title = "Confirm"
      loadingDialogRef.componentInstance.actionsNum = 2;
      loadingDialogRef.componentInstance.action1Label = "No"
      loadingDialogRef.componentInstance.action2Label = "Yes"
      loadingDialogRef.componentInstance.action1Callback = ()=>{loadingDialogRef.close()}
      loadingDialogRef.componentInstance.action2Callback = ()=>{
        console.log("in dialog confirming stop")
        ipc.stop();
        this.copyingPromise.then((r)=>{
          console.log("now we have stopped")
          this.workerListener.removeListener();
          console.log(r.status)
          loadingDialogRef.close()
        })
      }
  }

  goToMainMenu(){
    this.router.navigate(['home'])
  }

}
