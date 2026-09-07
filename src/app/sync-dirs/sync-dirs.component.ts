import { Component, NgZone, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { BackupService } from '../core/services/backup/backup.service';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmationDialogComponent, LoadingDialogComponent } from '../shared/components';
import { WorkerCommunicator as ipc } from '../../../app/workers/worker-communicator'
import { WorkerListener, WorkerResponse } from '../../../app/workers/ipc.interfaces';
import { IncrementalDialogComponent } from '../incremental-dialog/incremental-dialog.component';
import { MyDataSource, ScrollableListComponent } from '../scrollable-list/scrollable-list.component';
import { DialogRef } from '@angular/cdk/dialog';
import { throwError } from 'rxjs';
import { error } from 'console';
import { goToMainMenuAndReload } from '../shared/utils/go-to-main-menu';



class SyncDirsError extends Error {
  constructor(message: string) {
      super(message);
      this.name = "SyncDirsError";
      Object.setPrototypeOf(this, SyncDirsError.prototype);
  }
}



@Component({
  selector: 'sync-dirs',
  templateUrl: './sync-dirs.component.html',
  styleUrl: './sync-dirs.component.scss'
})
export class SyncDirsComponent {
  constructor(private router: Router, private route: ActivatedRoute, public backup: BackupService, public dialog: MatDialog, public ngZone: NgZone) { }

  workerListener!: WorkerListener;
  scrollableLogsListRef!:ScrollableListComponent;

  pathsOfFilesToBeCopied!:Array<string>
  pathsOfFilesToBeDeleted!:Array<string>

  copyFilesPromise!:Promise<any>
  deleteFilesPromise!:Promise<any>

  copyFilesPreviewPromise!:Promise<any>
  deleteFilesPreviewPromise!:Promise<any>

  getAllPathsMarkedForCopyPromise!:Promise<WorkerResponse>
  getAllPathsMarkedForDeletionPromise!:Promise<WorkerResponse>

  showProgressBar_=true;
  workIsInProgess_=true;
  workFinished_=false;

  showCommitedOperationsLogs=false;
  finishedDirSync=false;

  @ViewChild(ScrollableListComponent)  set scrollableLogsList(v: ScrollableListComponent) {
    setTimeout(() => {
      this.scrollableLogsListRef = v;
    }, 0);
  }
    


  async chooseDirectory(): Promise<string> {
    const dialogConfig = {
      title: 'Directory selection',
      buttonLabel: 'Select this directory',
      properties: ['openDirectory']
    };
    const res = await window.electronAPI.openDialog('showOpenDialog', dialogConfig);
    return res.filePaths[0];
  }

  getSource(): void {
    this.chooseDirectory().then((path) => {
      if (path != undefined) {
        this.backup.sourcePath = path;
        console.log(path)
      }
    });
  }

  getTarget(): void {
    this.chooseDirectory().then((path) => {
      if (path != undefined) {
        this.backup.targetPath = path;
        console.log(path)
      }
    });
  }

  holdOn = (ms: number = 1000) => {
    return new Promise<void>(resolve =>
      setTimeout(() => {
        resolve();
      }, ms)
    );
  }

  goToMainMenu() {
    goToMainMenuAndReload(this.router);
  }

  displayWarning(): Promise<string> {
    let resolve!: (value: string | PromiseLike<string>) => void;
    let reject!: (reason?: unknown) => void;
    let p = new Promise<string>(
      (res, rej) => {
        resolve = res;
        reject = rej;
      })

    const confirmDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '650px' });
    confirmDialog.disableClose = true;
    confirmDialog.componentInstance.message = `You have requested the synchronization of the directories: ${this.backup.sourcePath} and 
      ${this.backup.targetPath}. This means that at the end of the process, the two directories will have exactly the same contents.
      That is, if there is a file in ${this.backup.sourcePath} (template directory) which does not exist (or has been modified) in ${this.backup.targetPath}
      then the file will be copied from ${this.backup.sourcePath} to ${this.backup.targetPath}. Also in case there is a file in
      ${this.backup.targetPath} which does not exist in ${this.backup.sourcePath} then this file will be DELETED. So be careful as this
      option may delete files from ${this.backup.targetPath}. If you are not sure you want to proceed press 'cancel'.
      Otherwise press 'continue'.`;
    confirmDialog.componentInstance.title = "Warning"
    confirmDialog.componentInstance.actionsNum = 2;
    confirmDialog.componentInstance.action1Label = "Cancel";
    confirmDialog.componentInstance.action1Callback = () => {
      confirmDialog.close();
      reject("cancel");
    }
    confirmDialog.componentInstance.action2Label = "Continue";
    confirmDialog.componentInstance.action2Callback = () => {
      confirmDialog.close();
      resolve("continue");

    }
    return p;
  }

  checkPathsSelectionIsOk(): Promise<number> {
    let resolve!: (value: number | PromiseLike<number>) => void;
    let reject!: (reason?: unknown) => void;
    let p = new Promise<number>(
      (res, rej) => {
        resolve = res;
        reject = rej;
      })

    if(!this.backup.sourcePath || !this.backup.targetPath){
      const confirmDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '650px' });
      confirmDialog.disableClose = true;
      confirmDialog.componentInstance.message = `You have not selected the directories' paths`;
      confirmDialog.componentInstance.title = "Synchronize directories"
      confirmDialog.componentInstance.actionsNum = 1;
      confirmDialog.componentInstance.action1Label = "Ok";
      confirmDialog.componentInstance.action1Callback = () => {
        confirmDialog.close();
        resolve(0);
      } 
    }else{
      resolve(1);
    }
      return p
  }

  async getPathsOfFilesToBeCopied(): Promise<string[]> {
    this.getAllPathsMarkedForCopyPromise = ipc.diff(this.backup.sourcePath, this.backup.targetPath);
    return (await this.getAllPathsMarkedForCopyPromise).res;
  }

  async getPathsOfFilesToBeDeleted(): Promise<string[]> {
    //We repurpose the same method as for getPathsOfFilesToBeCopied changing the order of the parameters.
    this.getAllPathsMarkedForDeletionPromise = ipc.diff(this.backup.targetPath, this.backup.sourcePath);
    return (await this.getAllPathsMarkedForDeletionPromise).res;
  }

  async previewOperationsBeforeCommiting(filePathsToBeCopied: Array<string>, filePathsToBeDeleted: Array<string>, componentInstance: IncrementalDialogComponent) {
    // create missing files inside the dir to be synched.
    //We have repurposed some already existing functions. In this case incremental-preview.  
    this.workerListener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        switch (response.key) {
          case 'incremental-preview':
            if (response.status == 'running') {
              this.backup.previewLogsStream.next(response.res);
              console.log('running in incremental preview')
            } else if (response.status == 'completed' || response.status == 'stopped') {
              console.log('completed in incremental preview');
              this.backup.previewLogsStream.complete();            
            }
            break;
        }
      });
    });
    
    this.copyFilesPreviewPromise = ipc.incrementalPreview(filePathsToBeCopied, this.backup.sourcePath, this.backup.targetPath);
    await this.copyFilesPreviewPromise;
    // By the time copyFilesPreviewPromise has resolved, this listener has already seen and handled the final
    // 'completed'/'stopped' message for 'incremental-preview' (both this listener and sendAndAwaitResponse's own
    // internal one fire for the same event before either can remove the other - see WorkerCommunicator.
    // sendAndAwaitResponse's own doc comment). Removing it now - instead of leaving it registered forever, as
    // before - is therefore safe and stops it (and the one about to be registered below for the delete phase)
    // from silently accumulating on every sync attempt for the lifetime of this component.
    this.workerListener.removeListener();
    console.log("Finished incremental preview ")
    await componentInstance.streamFinishedPromise();
    this.backup.resetStream();
    componentInstance.restartConnection();

    // deleting files from dir to be synched
    this.workerListener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        switch (response.key) {
          case 'delete-files-and-dirs-for-dir-sync':
            if (response.status == 'running') {
              console.log('running in delete-files-and-dirs-for-dir-sync')
              this.backup.previewLogsStream.next(response.res);
            } else if (response.status == 'completed' || response.status == 'stopped') {
              this.backup.previewLogsStream.complete();
              console.log('completed in delete-files-and-dirs-for-dir-sync')
            }
            break;
        }
      });
    });
    //Setting commit = false means we only want a peview of the operations.
    this.deleteFilesPreviewPromise = ipc.deleteFilesAndDirsForDirSync(filePathsToBeDeleted, /*commit=*/false, this.backup.sourcePath, this.backup.targetPath);
    await this.deleteFilesPreviewPromise;
    console.log("Finished  deleteFilesAndDirsForDirSync")
    // Same cleanup as after the copy-preview phase above - this listener has already handled the final message
    // by the time deleteFilesPreviewPromise resolved, and nothing below reuses it (commitAllSyncOperations, if
    // reached, registers its own).
    this.workerListener.removeListener();

  }


  async syncDirs() {
    if(!await this.checkPathsSelectionIsOk()){
      return;
    }
    await this.displayWarning()
    this.backup.resetStream();

    let userCancelledOperation = false;
    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
    loadingDialogRef.afterClosed().subscribe(async result => {
      if(result == false){
        userCancelledOperation = true;
        ipc.stop();
        await this.getAllPathsMarkedForCopyPromise;
        ipc.stop();
        await this.getAllPathsMarkedForDeletionPromise; 
      }
    });

    /*Repurpose IncrementalDialogComponent. First open the dialog.This dialog listens for and diplsays the logs 
    for the operations to be done.*/
    //const dialogRef = this.dialog.open(IncrementalDialogComponent, { disableClose: true, width: 'inherit'});

    // try/catch: without it, a rejected ipc.diff() (e.g. sourcePath/targetPath became inaccessible) threw
    // unhandled here, leaving the disableClose loading dialog open forever with no error shown.
    try {
      this.pathsOfFilesToBeCopied = await this.getPathsOfFilesToBeCopied();
      this.pathsOfFilesToBeDeleted = await this.getPathsOfFilesToBeDeleted();
    } catch (error) {
      if (!userCancelledOperation) {
        loadingDialogRef.close();
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `An error occurred while comparing the directories: ${error}`;
        errorDialog.componentInstance.action1Callback = () => {
          errorDialog.close();
          goToMainMenuAndReload(this.router);
        }
      }
      return;
    }

    //If pathsOfFilesToBeDeleted contains paths which are also present in pathsOfFilesToBeCopied then delete those paths.
    //This happens when we have files which do exist, but have been modified.
    //This will be registered as paths to be deleted.
    this.pathsOfFilesToBeDeleted = this.pathsOfFilesToBeDeleted.filter((k) => {
      return this.pathsOfFilesToBeCopied.indexOf(k) == -1;
    });

    if(userCancelledOperation){return}

    loadingDialogRef.close();

    const dialogRef = this.dialog.open(IncrementalDialogComponent, { disableClose: true, width: 'inherit' });
    dialogRef.componentInstance.showProgressBar();
    dialogRef.componentInstance.disableProceedBtn();
    await this.holdOn(0);

    let previewOperationsPromise = this.previewOperationsBeforeCommiting(this.pathsOfFilesToBeCopied, this.pathsOfFilesToBeDeleted,
       dialogRef.componentInstance);

    previewOperationsPromise.then((res)=>{
      // In case the user pressed cancel then the dialog gets destroyed possibly before previewOperationsPromise returns.
      //So we check if dialogRef exists.
      if(dialogRef.componentInstance){
        //Already in sync.
        if(dialogRef.componentInstance.getNumOfLogs() == 0){
          dialogRef.close();
          const confirmDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '650px' });
          confirmDialog.disableClose = true;
          confirmDialog.componentInstance.message = `The directories are already synced. No action needs to be taken.`;
          confirmDialog.componentInstance.title = "Directory synchronization"
          confirmDialog.componentInstance.actionsNum = 1;
          confirmDialog.componentInstance.action1Label = "Ok";
          confirmDialog.componentInstance.action1Callback = () => {
            confirmDialog.close();
          }
        }else{
          dialogRef.componentInstance.progessBarCompleted();
          dialogRef.componentInstance.enableProceedBtn();
        }
      }
    })

    dialogRef.beforeClosed().subscribe(async result => {
      if (result == 'cancel') {
        ipc.stop();
        this.workerListener.removeListener();

        const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
        loadingDialogRef.componentInstance.showCancelButton=false;


        await this.getAllPathsMarkedForCopyPromise;
        ipc.stop();
        await this.getAllPathsMarkedForDeletionPromise;
        ipc.stop();
        await this.copyFilesPreviewPromise;
        ipc.stop();
        await this.deleteFilesPreviewPromise;


        loadingDialogRef.close();

        /* Here we have repurposed a component. Maybe the name 'sync_dirs' or even 'confirm' would be more appropriate instead of 'copy_selected'.
        but the idea is the same. */
      } else if (result == 'copy_selected') {
        // Note that we do not allow the user to proceed without seeing the entire preview. If we did we would have to cancel and wait for
        //all the promises to return.

        previewOperationsPromise.then((res) => {
          this.dialog.closeAll();
          const confirmCopyDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
          confirmCopyDialog.componentInstance.message =
            `Are you sure you want to sync the directories? This means that after the end of the process the directory 
            ${this.backup.targetPath} will become exactly the same as the directory: ${this.backup.sourcePath}.`;
          confirmCopyDialog.componentInstance.title = "Confirmation"
          confirmCopyDialog.componentInstance.actionsNum = 2;
          confirmCopyDialog.componentInstance.action1Label = "No, cancel"
          confirmCopyDialog.componentInstance.action2Label = "Yes, continue"
          confirmCopyDialog.componentInstance.action1Callback = () => { confirmCopyDialog.close(); }
          confirmCopyDialog.componentInstance.action2Callback = async () => {
            confirmCopyDialog.close();
            this.backup.resetStream();
            this.showCommitedOperationsLogs=true;
            //Wait a bit for thecomponent to be loaded. I know, this is not the most elegant solution though..
            await this.holdOn(500);
            this.commitAllSyncOperations().then((status)=>{
              if(status=="completed"){
                this.finishedDirSync=true;
                this.workFinished_=true;
                this.workIsInProgess_=false;
                const confirmCopyDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
                confirmCopyDialog.componentInstance.message =`Directory synchronization completed successfully.`;
                confirmCopyDialog.componentInstance.title = "Directory synchronization"
                confirmCopyDialog.componentInstance.actionsNum = 1;
                confirmCopyDialog.componentInstance.action1Label = "Ok";
                confirmCopyDialog.componentInstance.action1Callback = () => { confirmCopyDialog.close(); }
              }
            }).catch((err)=>{
                this.finishedDirSync=true;
                this.workFinished_=true;
                this.workIsInProgess_=false;
                const confirmCopyDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
                confirmCopyDialog.componentInstance.message =`Directory synchronization failed: ${err}`;
                confirmCopyDialog.componentInstance.title = "Error"
                confirmCopyDialog.componentInstance.actionsNum = 1;
                confirmCopyDialog.componentInstance.action1Label = "Ok";
                confirmCopyDialog.componentInstance.action1Callback = () => { confirmCopyDialog.close(); }
            });
          }
        });
      }
    });

  }

  async commitAllSyncOperations() {
    let status = null;
    
    // create missing files inside the dir to be synched.  
    this.workerListener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        switch (response.key) {
          case 'incremental-copy-files':
            if (response.status == 'running') {
              this.backup.previewLogsStream.next(response.res);
            } else if (response.status == 'completed' || response.status == 'stopped') {
              // Intentionally no-op: unlike previewOperationsBeforeCommiting, this method never calls
              // resetStream() between the copy and delete phases, so both phases share the same
              // previewLogsStream Subject. Completing it here would stop the delete phase's logs (below)
              // from reaching subscribers and would signal the log display that the whole commit is done
              // while it has really just started. The stream is completed once, after the delete phase
              // finishes (see the 'delete-files-and-dirs-for-dir-sync' case below).
            } else if(response.status == 'error'){
              // Intentionally no-op: this Promise.reject() used to be created and immediately discarded here -
              // nothing awaited or returned it, so it never actually surfaced anything. The real rejection
              // already happens on its own: copyFilesPromise (awaited below) is settled by
              // WorkerCommunicator.sendAndAwaitResponse's own internal listener on this same 'error' status, and
              // that rejection is what propagates out of this method to syncDirs()'s .catch().
            }
            break;
        }
      });
    });

    this.copyFilesPromise = ipc.incrementalCopyFiles(this.pathsOfFilesToBeCopied, this.backup.sourcePath, this.backup.targetPath);
    await this.copyFilesPromise;
    // See the identical cleanup (and its comment) in previewOperationsBeforeCommiting - this listener has
    // already handled the final message by the time copyFilesPromise resolved, and the delete-phase listener
    // registered next needs this one gone first so it isn't left dangling once THAT one is itself reassigned.
    this.workerListener.removeListener();

    // deleting files from dir to be synched
    this.workerListener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        switch (response.key) {
          case 'delete-files-and-dirs-for-dir-sync':
            if (response.status == 'running') {
              this.backup.previewLogsStream.next(response.res);
            } else if (response.status == 'completed' || response.status == 'stopped') {
              this.backup.previewLogsStream.complete();
              status = response.status
            } else if(response.status == 'error'){
              // Intentionally no-op - see the identical comment on the copy phase's 'error' case above.
              // deleteFilesPromise (awaited below) is what actually rejects.
            }
            break;
        }
      });
    });

    this.deleteFilesPromise = ipc.deleteFilesAndDirsForDirSync(this.pathsOfFilesToBeDeleted, /*commit=*/true, this.backup.sourcePath, this.backup.targetPath);
    await this.deleteFilesPromise;
    // Same cleanup as previewOperationsBeforeCommiting/the copy phase above - nothing after this reuses
    // this.workerListener, so leaving it registered would just leak for the rest of the component's lifetime.
    this.workerListener.removeListener();

    return status;

  }

  onError() {

  }

  async cancelDirSyncCommit(){
    ipc.stop();

    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true, width: '400px' });
    loadingDialogRef.componentInstance.showCancelButton=false;

    await this.copyFilesPromise;
    
    ipc.stop();

    await this.deleteFilesPromise;

    loadingDialogRef.close();

    this.workFinished_=true;
    this.workIsInProgess_=false;
    const confirmCopyDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
    confirmCopyDialog.componentInstance.message =`Directory synchronization has stopped.
    You can see the actions performed before the interruption in the logs.`;
    confirmCopyDialog.componentInstance.title = "Dir Sync"
    confirmCopyDialog.componentInstance.actionsNum = 1;
    confirmCopyDialog.componentInstance.action1Label = "Ok";
    confirmCopyDialog.componentInstance.action1Callback = () => { confirmCopyDialog.close(); }

    
  }


}
