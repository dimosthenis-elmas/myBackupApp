import { Component, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { FilesTreeComponent } from '../files-tree/files-tree.component';
import { BackupService } from '../core/services/backup/backup.service';
import { IncrementalDialogComponent } from '../incremental-dialog/incremental-dialog.component';
import { ConfirmationDialogComponent } from '../shared/components/confirmation-dialog/confirmation-dialog.component';
import { LoadingDialogComponent } from '../shared/components/loading-dialog/loading-dialog.component';
import { Subject } from 'rxjs';
import { WorkerCommunicator as ipc } from '../../../app/workers/worker-communicator'
import { WorkerListener, WorkerResponse } from '../../../app/workers/ipc.interfaces';
import { goToMainMenuAndReload } from '../shared/utils/go-to-main-menu';

@Component({
  selector: 'app-incremental',
  templateUrl: './incremental.component.html',
  styleUrls: ['./incremental.component.scss']
})
export class IncrementalComponent implements OnInit, OnDestroy {

  @ViewChild(FilesTreeComponent)
  private filesTree!: FilesTreeComponent;
  
  public diffTreeIsEmpty: boolean = false;

  private workerListener!: WorkerListener;

  constructor(public router: Router, private route: ActivatedRoute, public dialog: MatDialog, public backup: BackupService, private ngZone: NgZone) { }
  
  public allFilesSelected = false;
  public panelOpenState = true;

  ngOnInit(): void {}

  ngOnDestroy():void {
    if(this.filesTree){
      this.filesTree.setTreeData([]);
    }
    this.diffTreeIsEmpty = true;
    ipc.onDestroy();
  }

  showHelpDialog(){
    const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '750px'});
    loadingDialogRef.componentInstance.message =  
    `This choice: 
    \n1) Copies to the backup all the files that exist only in the selected source directory and not in the backup.
    \n2) Rewrites to the backup all the files that have been modified.
    \nThis option will only add or modify existing files in the backup.
    \nIt will not delete any files from the backup if they have been deleted from your source directory.`;
    loadingDialogRef.componentInstance.title = "Help"
  }

  selectAllFiles(selected: boolean){
    // Keep the "Select all" checkbox's own [checked] binding (allFilesSelected) in sync with what this
    // actually did to the tree - see the identical fix/comment on selectAllFiles in
    // optical-disc-backup-data-retriever.component.ts for the full explanation of the bug this closes (the
    // checkbox used to stay visually checked regardless of the real selection state, since nothing ever
    // updated it after its initial declaration).
    this.allFilesSelected = selected;
    if(selected){
      this.filesTree.selectAllNodes();
    }else{
      this.filesTree.deselectAllNodes();
    }
  }

  onError(err: any){
      this.dialog.closeAll();
      this.workerListener.removeListener();
      const confirmCopyDialog = this.dialog.open(ConfirmationDialogComponent);
      confirmCopyDialog.componentInstance.message = err;
      confirmCopyDialog.componentInstance.title = "Error"
      confirmCopyDialog.componentInstance.actionsNum = 1;
      confirmCopyDialog.componentInstance.action1Label = "Ok"
      confirmCopyDialog.componentInstance.action1Callback = () => { confirmCopyDialog.close() }
  }

  proceedToPreview(){
    this.backup.resetStream();
    this.workerListener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        //console.log(arg);
        console.log(response.status)
        switch (response.key) {
          case 'incremental-preview':
            if(response.status == 'running'){
              this.backup.previewLogsStream.next(response.res);
            }else if(response.status == 'completed' || response.status == 'stopped'){
              this.backup.previewLogsStream.complete();
            }
            break;
        }
      });
    });
    
    let logsPromise: Promise<WorkerResponse>    
    
    let selectedFiles = this.filesTree.getSelectedData();
    if (!selectedFiles.length) {
      this.workerListener.removeListener();
      const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
      loadingDialogRef.componentInstance.message =
        `You have not selected any files or folders`;
      loadingDialogRef.componentInstance.title = "Paths selection"
      return;
    }
    const dialogRef = this.dialog.open(IncrementalDialogComponent, { disableClose: true, width: 'inherit'});
    /*ipc.sendRequestToWorker({ 
      key: 'incremental-preview',
      params:{
        sourceOnlyPaths: selectedFiles,
        source: this.backup.sourcePath,
        target: this.backup.targetPath
      } 
    });*/
    logsPromise = ipc.incrementalPreview(selectedFiles, this.backup.sourcePath, this.backup.targetPath);

    logsPromise.catch((err)=>{
        this.onError(err);
      });

    dialogRef.beforeClosed().subscribe(result => {
      if(result == 'cancel'){
        ipc.stop();
        this.workerListener.removeListener();
      }else if(result == 'copy_selected'){
        //The user may have clicked the button before the logs finished printing.
        //Stop printing the preview logs
        ipc.stop();
        logsPromise.then((res) => {
          console.log("PROMISE RETURNS AND THIS IS THE RESULT STATUS: " + res.status);
          this.dialog.closeAll();
          const confirmCopyDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
          confirmCopyDialog.componentInstance.message =
            `Are you sure you want to copy the files to the backup?`;
          confirmCopyDialog.componentInstance.title = "Confirm"
          confirmCopyDialog.componentInstance.actionsNum = 2;
          confirmCopyDialog.componentInstance.action1Label = "No"
          confirmCopyDialog.componentInstance.action2Label = "Yes"
          confirmCopyDialog.componentInstance.action1Callback = () => { confirmCopyDialog.close() }
          confirmCopyDialog.componentInstance.action2Callback = () => {
            this.router.navigate(['incremental-copying'], { state: { selectedFiles: selectedFiles } });
          }
        });
       
        /*
        ipc.sendRequestToWorker({ 
          key: 'incremental-preview',
          params:{
            sourceOnlyPaths: selectedFiles,
            source: this.backup.sourcePath,
            target: this.backup.targetPath
          } 
        });
        */
      }
    });

    //setTimeout(()=>{this.messsage_queue.next("A MESSAGE")},2000);
    //setTimeout(()=>{this.messsage_queue.next("A MESSAGE")},4000);
  }

  /*penDialog() {
    const dialogRef = this.dialog.open(IncrementalDialogComponent);
    dialogRef.afterClosed().subscribe(result => {
      console.log(`Dialog result: ${result}`);
      if(result){
        const confirmDialogRef = this.dialog.open(ConfirmationDialogComponent); 
      }
    });

  }*/

  ngAfterViewInit():void {
    //TODO change this component interaction using @ViewChild. Maybe use @Input? See https://angular.io/guide/component-interaction
    //setTimeout(() => {}, 0);

    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });

    let diffPromise = ipc.diff(this.backup.sourcePath, this.backup.targetPath)
    /*
    //This block is useful for testing only. Use this to avoid having to wait for diff to complete when testing with large directories.
    let diffPromise = new Promise<WorkerResponse>((resolve) => {
      let res = [];
      var fs = require('fs');
      //fs.writeFile('myjsonfile.json', JSON.stringify({files: args.res}), 'utf8', ()=>{});
      
      fs.readFile('myjsonfile.json', 'utf8', function readFileCallback(err, data) {
        if (err) {
          console.log(err);
        } else {
          res = JSON.parse(data).files; //now it an object
          console.log(res.length)
          resolve({ key: "diff", status: "completed", res: res })
        }
      });
    });
    */

    diffPromise.then((args)=>{
      this.createDiffTree(args.res).then(()=>{
        loadingDialogRef.close();
      });
    }).catch((error)=>{
      // Without this, a rejected diff() (e.g. sourcePath/targetPath became inaccessible) left the disableClose
      // loading dialog open forever with no error shown and no way for the user to dismiss it.
      loadingDialogRef.close();
      const errorDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
      errorDialog.componentInstance.title = "Error";
      errorDialog.componentInstance.message = `An error occurred while comparing the directories: ${error}`;
      errorDialog.componentInstance.action1Callback = () => {
        errorDialog.close();
        goToMainMenuAndReload(this.router);
      }
    })


    loadingDialogRef.afterClosed().subscribe(result => {
      if(result == false){
        console.log("Sending stop")
        ipc.stop();
        diffPromise.then(()=>{
          goToMainMenuAndReload(this.router);
        })
      }
    });

  }

  async createDiffTree(paths: Array<string>){
    if(paths.length != 0){
      this.diffTreeIsEmpty = false;
      await this.filesTree.setTreeData(paths);
    }else{
      this.diffTreeIsEmpty = true;
    }
  }

}
