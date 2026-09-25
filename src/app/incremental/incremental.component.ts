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
import { parseProgressFromLine, parseScanItemsProgress } from '../shared/utils/progress-line';

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

    let selectedFiles = this.filesTree.getSelectedData();
    if (!selectedFiles.length) {
      const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
      loadingDialogRef.componentInstance.message =
        `You have not selected any files or folders`;
      loadingDialogRef.componentInstance.title = "Paths selection"
      return;
    }

    this.workerListener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        //console.log(arg);
        console.log(response.status)
        switch (response.key) {
          case 'incremental-preview':
            if(response.status == 'running'){
              // Split out the per-item "(i of N)" progress marker (see createTree in worker.ts) from the rest
              // of this batch's descriptive lines before forwarding to the visible log - it drives the
              // dialog's progress bar, not one more line in the scrolling list.
              const visibleLines = (response.res as string[]).filter((line) => {
                const progress = parseProgressFromLine(line);
                if (progress) {
                  dialogRef.componentInstance.updateProgress(Math.round((progress.current / selectedFiles.length) * 100));
                  return false;
                }
                return true;
              });
              if (visibleLines.length > 0) { this.backup.previewLogsStream.next(visibleLines); }
            }else if(response.status == 'completed' || response.status == 'stopped'){
              this.backup.previewLogsStream.complete();
            }
            break;
        }
      });
    });

    let logsPromise: Promise<WorkerResponse>

    const dialogRef = this.dialog.open(IncrementalDialogComponent, { disableClose: true, width: 'inherit'});
    dialogRef.componentInstance.showProgressBar();
    /*ipc.sendRequestToWorker({ 
      key: 'incremental-preview',
      params:{
        sourceOnlyPaths: selectedFiles,
        source: this.backup.sourcePath,
        target: this.backup.targetPath
      } 
    });*/
    // 'keep-both': a name that is a file on one side and a folder on the other never costs the backup anything - see
    // NameClash (ipc.interfaces.ts).
    logsPromise = ipc.incrementalPreview(selectedFiles, this.backup.sourcePath, this.backup.targetPath, 'keep-both');

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
    loadingDialogRef.componentInstance.message = 'Comparing directories';

    // Shows this whole step as one real, continuous 0-100% bar instead of a plain spinner - the first half
    // (0-50%) is diff()'s scan phase, reporting a real "(i of N)" percentage against an upfront probed total
    // (see countAllFilesQuick/parseScanItemsProgress) rather than an open-ended running count, and the second
    // half (50-100%) is its comparison phase, reporting its own real "(i of N)" (see parseProgressFromLine) -
    // both known totals, so both halves are genuine percentages, not an estimate. Shown by LoadingDialogComponent
    // as just its filling circle (`percent`) - no text or counter. A local listener (not this.workerListener, which proceedToPreview/onError use for a later, separate phase
    // of this same wizard) so the two can never be confused with or clobber each other.
    const diffProgressListener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        if (response.key === 'diff' && response.status === 'running') {
          const lines = response.res as string[];
          for (const line of lines) {
            const compareProgress = parseProgressFromLine(line);
            const scanProgress = parseScanItemsProgress(line);
            if (compareProgress) {
              loadingDialogRef.componentInstance.percent = 50 + Math.round((compareProgress.current / compareProgress.total) * 50);
            } else if (scanProgress) {
              loadingDialogRef.componentInstance.percent = Math.round((scanProgress.current / scanProgress.total) * 50);
            }
          }
        }
      });
    });

    // skipUnreadable: an entry that cannot be read (e.g. a folder Windows denies listing) is left out and reported
    // to the user, instead of making the whole comparison fail. Only safe here because this flow never deletes
    // anything. (A link is not unreadable: it is one entry, copied as a link.)
    let diffPromise = ipc.diff(this.backup.sourcePath, this.backup.targetPath, 'source-newer-or-different-size', true)
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
      diffProgressListener.removeListener();
      this.createDiffTree(args.res).then(()=>{
        loadingDialogRef.close();
      });
    }).catch((error)=>{
      diffProgressListener.removeListener();
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
