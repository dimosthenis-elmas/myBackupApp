import { Component, inject, NgZone, OnDestroy, OnInit, ViewChild, ViewChildren, QueryList } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { FilesTreeModule } from '../files-tree/files-tree.module';
import { BackupService } from '../core/services/backup/backup.service';
import { IncrementalDialogComponent } from '../incremental-dialog/incremental-dialog.component';
import { ConfirmationDialogComponent } from '../shared/components/confirmation-dialog/confirmation-dialog.component';
import { LoadingDialogComponent } from '../shared/components/loading-dialog/loading-dialog.component';
import { Subject } from 'rxjs';
import { WorkerCommunicator as ipc } from '../../../app/workers/worker-communicator'
import { getDiscIdHash, OPTICAL_DRIVE_LETTER_CONVENTION } from '../shared/utils/disc-id-hash';
import { WorkerListener, WorkerResponse } from '../../../app/workers/ipc.interfaces';
import { filesMetadata } from '../../types/interface';
import { SerialQueue } from '../shared/utils/serial-queue';
import { PART_FILE_PATTERN } from '../shared/utils/part-file-pattern';

import {FormBuilder, Validators, FormsModule, ReactiveFormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatInputModule} from '@angular/material/input';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatStepperModule} from '@angular/material/stepper';
import {MatCheckboxModule} from '@angular/material/checkbox';
import { FilesTreeComponent } from '../files-tree/files-tree.component';
import { create } from 'domain';
import { MatCard } from '@angular/material/card';
import { MatButton } from '@angular/material/button'
import {MatDivider} from '@angular/material/divider';
import { MatIcon } from "@angular/material/icon";
import { MatCardModule } from '@angular/material/card';
import {MatSelectModule} from '@angular/material/select';
import { CommonModule } from '@angular/common';
import { MatChip } from '@angular/material/chips';
import { MatChipSet } from '@angular/material/chips';


@Component({
  selector: 'backup-to-optical-media',
  standalone: true,
  imports: [
    MatStepperModule,
    FormsModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    FilesTreeModule,
    MatCheckboxModule,
    MatCard,
    MatButton,
    MatDivider,
    MatIcon,
    MatCardModule,
    MatSelectModule,
    CommonModule,
    MatChip,
    MatChipSet
  ],
  templateUrl: './backup-to-optical-media.component.html',
  styleUrl: './backup-to-optical-media.component.scss'
})
export class BackupToOpticalMediaComponent implements OnInit, OnDestroy{

  public step='step_1';
  private splitLargeFiles:boolean=false;

  private _formBuilder = inject(FormBuilder);

  public allFilesSelected = true;

  firstFormGroup = this._formBuilder.group({
    firstCtrl: ['', Validators.required],
  });
  secondFormGroup = this._formBuilder.group({
    secondCtrl: ['', Validators.required],
  });

  totalNumberOfDisksNeeded!:number;

  // This is used for the for loop in the template. It holds the numbers 1..n_disks
  _disks!: Array<number>


  isLinear = false;

  @ViewChildren('cmp')
  private filesTrees!: QueryList<FilesTreeComponent>;
  
  private workerListener!: WorkerListener;
  private tempDataDirectoryPath!: string;
  /** Full path (folder + file name), chosen by the user via a save dialog, where the cold storage metadata
   * JSON is written/updated for this session. See chooseSaveFile(). */
  private coldStorageMetadataJSONPath!: string;
  /** Serializes sendToImgBurn's read-modify-write of the shared cold storage metadata JSON across discs - see
   *  SerialQueue's own doc comment for why this is needed (the stepper is non-linear and every disc's "Send to
   *  ImgBurn" button is always enabled). */
  private metadataUpdateQueue = new SerialQueue();
  /** Whether disc i has been sent to ImgBurn at least once yet - gates both "Confirm disc burned" (can't
   *  confirm a disc that was never sent) and re-sending. */
  public sentDiscs: boolean[] = [];
  /** Whether the user has confirmed disc i was actually burned - see confirmDiscBurned(). Intentionally pure
   *  in-memory state, never persisted: if the app closes mid-job, the user starts over. That is an explicit
   *  decision (no resume support), not an oversight - please don't "fix" this into a persistence feature. */
  public confirmedDiscs: boolean[] = [];
  /** For each disc i, the bare-relative (relative to this.backup.sourcePath) large-file-split-piece paths that
   *  were actually materialized and burned for that disc - captured once in sendToImgBurn, since it can include
   *  a rare surplus piece (see materializeOpticalMediaDiscPieces) that was never part of the tree's own
   *  selection and so cannot be recovered later by re-querying the tree. confirmDiscBurned reads this to know
   *  exactly which real temp-dir files to delete. */
  private sentDiscPartPaths: string[][] = [];
  /** Name of this cold storage collection of discs, provided once by the user in step_1 and burned onto every
   * disc's UDF volume label as "<name> Disc <N>" (see sendToImgBurn/createIBB_file) - so all discs from the
   * same backup carry a recognizable, shared label. */
  public coldStorageCollectionName: string = '';

  optical_media_choices: {value: string, viewValue: string, capacity: number}[] = [
    {value: 'cd', viewValue: 'CD (700 MB)', capacity: 0.7e9},
    {value: 'dvd', viewValue: 'DVD (4.7 GB)', capacity: 4.7e9},
    {value: 'blu-ray', viewValue: 'Blu ray (25 GB)', capacity: 25e9},
    {value: 'blu-ray', viewValue: 'Blu ray (50 GB)', capacity: 50e9},
    {value: 'blu-ray', viewValue: 'Blu ray (100 GB)', capacity: 100e9}
  ];

  selected_optical_medium!: {value: string, viewValue: string, capacity: number};

  constructor(public router: Router, private route: ActivatedRoute, public dialog: MatDialog, public backup: BackupService, private ngZone: NgZone) { }

  ngOnInit(): void {
    
  }

  ngAfterViewInit(): void {
    //console.log(this.filesTrees.toArray());
    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });

    this.createTrees().then(()=>{
      loadingDialogRef.close();
    })

    loadingDialogRef.afterClosed().subscribe(result => {
      if(result == false){
        console.log("Sending stop")
        ipc.stop();
        this.router.navigate(['main-menu']);
      }
    });
  
  }

  goToMainMenu(){
    this.router.navigate(['main-menu']);
  }

  goToStep2(){
    this.totalNumberOfDisksNeeded = this.backup.opticalMediaPartitioning.length;
    this._disks = [...Array(this.totalNumberOfDisksNeeded).keys()];
    this.sentDiscs = Array(this.totalNumberOfDisksNeeded).fill(false);
    this.confirmedDiscs = Array(this.totalNumberOfDisksNeeded).fill(false);
    this.sentDiscPartPaths = Array(this.totalNumberOfDisksNeeded).fill(null).map(() => []);
    this.step='step_2'
  }

  async chooseDirectory (): Promise<string>{
    const dialogConfig = {
      title: 'Select directory',
      buttonLabel: 'Select this directory',
      properties: ['openDirectory']
    };
    const res = await window.electronAPI.openDialog('showOpenDialog', dialogConfig);
    return res.filePaths[0];
  }

  /** Opens a native "Save As" dialog so the user can choose where (and under what file name) to save the
   * cold storage metadata JSON, instead of it always being written to the app's temp data directory.
   * @return the chosen full path, or undefined if the user canceled the dialog. */
  async chooseSaveFile(defaultFileName: string): Promise<string | undefined>{
    const dialogConfig = {
      title: 'Select where to save the cold storage metadata JSON',
      buttonLabel: 'Save',
      defaultPath: defaultFileName,
      filters: [{ name: 'JSON files', extensions: ['json'] }]
    };
    const res = await window.electronAPI.openDialog('showSaveDialog', dialogConfig);
    return res.canceled ? undefined : res.filePath;
  }

  getSource():void{
    this.chooseDirectory().then((path)=>{
      if(path != undefined){
        this.backup.sourcePath = path;
        console.log(path)
      }
    });
  }

  holdOn = () => {
    return new Promise<void>(resolve =>
      setTimeout(() => {
        resolve();
      },1000)
    );
  }

  WriteToOpticalMediaProceed():void{

      if (this.backup.sourcePath && this.selected_optical_medium && this.coldStorageCollectionName.trim()) {
        const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
        let promise = ipc.partitionBackupToOpticalMedia(this.backup.sourcePath, this.selected_optical_medium.capacity, this.splitLargeFiles);
  
        promise.then((response)=>{
  
          if(response.status == "completed"){
  
          console.log(JSON.stringify(response));
          
          /* the response from the worker returns the full paths relative to the host file system.
           Since we are indifferent for the full system file structure we trim the 'this.backup.sourcePath'
           part from all paths. This way our root becomes the directory chosen by the user in the dialog.*/
          let opticalDiskPartitioningTrimmed = response.res.map(
            (subarray)=>{
              return subarray.map(x=>{
                x.path = x.path.replace(this.backup.sourcePath + "\\", "");
                return x;              
              })
          });

          if(this.splitLargeFiles){
            /*In case there are large files which have been splitted, the splits are stored in the temp data directory which is
              different from the source directory (this.backup.sourcePath). Thus we also trim the path to this directory*/
            opticalDiskPartitioningTrimmed = opticalDiskPartitioningTrimmed.map(
              (subarray)=>{
                return subarray.map(x=>{
                  x.path = x.path.replace(this.tempDataDirectoryPath, "");              
                  return x;
                })
            });
          }
          
  
          loadingDialogRef.close();
          
          /* Send the paths to the backup service. This is needed because we are going to change the compoment loaded,
           using router.navigate and thus the data must be somehow available to the new component.
          */
          this.backup.opticalMediaPartitioning = opticalDiskPartitioningTrimmed;
  
          const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
          infoDialog.componentInstance.title = "Backup to optical medium";
          const info_msg = `To burn the backup to the optical medium of your choice (${this.selected_optical_medium.viewValue}) you will need ${response.res.length} discs in total.`
          infoDialog.componentInstance.message = info_msg;
          infoDialog.componentInstance.actionsNum = 2
          infoDialog.componentInstance.action2Label = "Cancel"
          infoDialog.componentInstance.action2Callback = ()=>{}
          infoDialog.componentInstance.action1Label = "Next"
          infoDialog.componentInstance.action1Callback = ()=>{
            this.proceedToStep2AfterChoosingSavePath();
          }
  
        }else{
          // User pressed "cancel" 
        }
        }).catch(err=>{
          console.log(JSON.stringify(err));
          loadingDialogRef.close();

          if(err.res.err_code == 'FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC'){
            const confirmDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
            confirmDialog.disableClose = true;
            confirmDialog.componentInstance.message = JSON.stringify(err.res.msg) + `\n\nBut wait, there might be a fix to this! This app could
            split those large files which don't fit to any single optical disc into parts for you and write those
            to the optical disks. For example if you have a large file myFile.zip the app
            could create a directory myFile.zip and add the parts myFile.zip.part_01 myFile.zip.part_02 etc. Would you like to proceed with
            this approach?`;
            confirmDialog.componentInstance.title = "Error - Too large files found"
            confirmDialog.componentInstance.actionsNum = 2;
            confirmDialog.componentInstance.action1Label = "No, thanks. Cancel operation.";
            confirmDialog.componentInstance.action1Callback = () => { 
              confirmDialog.close();
            }
            confirmDialog.componentInstance.action2Label = "Yes, split the large files";
            confirmDialog.componentInstance.action2Callback = async () => {
                this.splitLargeFiles = true;
                this.tempDataDirectoryPath = (await ipc.getTempDataDirectoryPath()).res;
                // Trailing backslash ensured the same way this.backup.sourcePath already is (see the "+ '\\'"
                // right above, in the un-split trim a few lines up) - without it, a split piece's real path
                // (e.g. "...\tempFilesCanBeDeleted\large-files\file.bin.part.001") loses only the directory NAME
                // when this.tempDataDirectoryPath is stripped out of it below, leaving a stray LEADING backslash
                // behind ("\large-files\file.bin.part.001") - which corrupts the real .ibb file's own directory
                // structure (an empty-named root directory entry, plus a doubled-backslash "large-files" entry) -
                // found for real (2026-08-27) via ui/test-backup-to-optical-media.js's real .ibb output. Same bug,
                // same fix, as add-missing-files-to-optical-media-cold-storage.component.ts's tempPath/
                // tempDataDirectoryPath (see that component's own comments on the identical issue).
                if (this.tempDataDirectoryPath[this.tempDataDirectoryPath.length - 1] != '\\') { this.tempDataDirectoryPath += '\\'; }
                console.log(this.tempDataDirectoryPath);
                
                const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
                infoDialog.componentInstance.title = "Info";
                const info_msg = `The feature you selected will split any too-large files into parts, one disc's worth at a time, in the temp data directory located in
                ${this.tempDataDirectoryPath}. Each disc's parts are only physically created when that disc is actually sent to ImgBurn, and are deleted again
                automatically once you confirm that disc was burned - so you don't need to manually clean up this directory yourself.`
                infoDialog.componentInstance.message = info_msg;
                infoDialog.componentInstance.actionsNum = 1
                infoDialog.componentInstance.action1Label = "Ok, got it."
                infoDialog.componentInstance.action1Callback = ()=>{
                  this.WriteToOpticalMediaProceed();
                }
                                                  
            }
            }else{
              const errorDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
              errorDialog.componentInstance.title = "Error";
              errorDialog.componentInstance.message = JSON.stringify(err);            
            }
        })
  
        loadingDialogRef.afterClosed().subscribe(result => {
              // If user pressed cancel button
              if(result == false){
                console.log("Sending stop")
                ipc.stop();
                loadingDialogRef.close();
              }
            });
  
      }else{
        const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent);
        loadingDialogRef.componentInstance.title = "Info";
        loadingDialogRef.componentInstance.message = `You must first select the path to the backup directory, the type of optical medium, and provide a name for this cold storage collection of discs.`;
      }

    }

  /** Asks the user where to save the cold storage metadata JSON (see chooseSaveFile), then - once a location
   * has been chosen - proceeds to step 2, writing the initial (empty) scaffold to that location. This is
   * pulled out of WriteToOpticalMediaProceed's "Next" callback so that, if the user cancels the save dialog,
   * we can just re-prompt without redoing the (potentially slow) partitioning work. */
  private async proceedToStep2AfterChoosingSavePath(): Promise<void> {
    const chosenPath = await this.chooseSaveFile('coldStorageMetadata.json');
    if (!chosenPath) {
      const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
      infoDialog.disableClose = true;
      infoDialog.componentInstance.title = "Save location required";
      infoDialog.componentInstance.message = `You need to choose where to save the cold storage metadata JSON file to continue.`;
      infoDialog.componentInstance.actionsNum = 2;
      infoDialog.componentInstance.action1Label = "Retry";
      infoDialog.componentInstance.action2Label = "Cancel";
      infoDialog.componentInstance.action1Callback = () => {
        infoDialog.close();
        this.proceedToStep2AfterChoosingSavePath();
      }
      infoDialog.componentInstance.action2Callback = () => {
        infoDialog.close();
      }
      return;
    }
    this.coldStorageMetadataJSONPath = chosenPath;

    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });

    this.goToStep2();
    let metadataJSON: string[][] = Array(this._disks.length).fill([]);
    await ipc.writeJSONtoDisk(this.coldStorageMetadataJSONPath, JSON.stringify(metadataJSON));

    await this.holdOn();

    this.createTrees().then(()=>{
      loadingDialogRef.close();
    })

    loadingDialogRef.afterClosed().subscribe(result => {
      if(result == false){
        console.log("Sending stop")
        ipc.stop();
        this.router.navigate(['main-menu']);
      }
    });
  }


  async createTrees():Promise<void> {
    for (let i = 0; i < this.filesTrees.toArray().length; i++) {
      await this.filesTrees.toArray()[i].setTreeData(
        this.backup.opticalMediaPartitioning[i].map(x=>{return x.path}),
        this.backup.opticalMediaPartitioning[i].map(x=>{return x.stats}));
      this.filesTrees.toArray()[i].expandAllNodes();
      this.filesTrees.toArray()[i].selectAllNodes();
      
    }
  }

  ngOnDestroy(): void {
    // leaving page ..
    ipc.stop();
  }

  selectAllFiles(i: number, selected: boolean){
    // Keep the "Select all" checkbox's own [checked] binding (allFilesSelected) in sync with what this
    // actually did to the tree - see the identical fix/comment on selectAllFiles in
    // optical-disc-backup-data-retriever.component.ts for the full explanation of the bug this closes (the
    // checkbox used to stay visually checked regardless of the real selection state, since nothing ever
    // updated it after its initial `= true` declaration). Note allFilesSelected is a single shared flag across
    // every disc's checkbox here (not per-index) - that's an existing, separate characteristic of this
    // component, unchanged by this fix.
    this.allFilesSelected = selected;
    if(selected){
      this.filesTrees.toArray()[i].selectAllNodes();
    }else{
      this.filesTrees.toArray()[i].deselectAllNodes();
    }
  }

  /*
  This creates an ImgBurn project. This will be used to send the files to ImbBurn.
  As for 'paths: Array<string>': An array of the paths to be written to the specific disk. Note that the paths are note full system paths,
  (for example C:\**\*\my_backup_dir\**\*\some_file). Rather they are of the form: my_backup_dir\**\*\some_file.
  This C:\**\*\ part of the path is given in sourcePath.
  */
  async createIBB_file (disk_id:number, paths: Array<string>, sourcePath: string){
    // This is a brand new cold storage, so disc numbering is always simply sequential from 1 - no existing
    // discs to offset by (see add-missing-files-to-optical-media-cold-storage.component.ts for the case where
    // discs are being added to an already-existing collection).
    const collectionName = this.coldStorageCollectionName.trim();
    const volumeLabel = (collectionName ? collectionName + ' ' : '') + 'Disc ' + (disk_id + 1);

    this.workerListener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        switch (response.key) {
          case 'create-IBB-file':
            if(response.status == 'completed'){
              console.log(response)
            }
            break;
          default:
            console.error('Got unknown message from ipcMain.')
            break;
        }
      });
    });

    // Await (previously fired-and-forgotten): ipc.createIBB_file() only resolves once the worker has actually
    // finished building the .ibb file and invoking ImgBurn. Without awaiting it, this method (and therefore the
    // caller's .then()) resolved on the next microtick instead - closing the loading dialog and silently
    // dropping any failure before the real work was done.
    await ipc.createIBB_file(disk_id, paths, sourcePath, volumeLabel);
  }

  async sendToImgBurn(i: number){
    // The bare-relative (relative to this.backup.sourcePath) paths currently selected in this disc's tree -
    // this is the plan's ESTIMATE for any large-file split piece among them (see estimateLargeFileSplitPieces
    // in worker.ts): a piece's path is already correctly predicted, but its size is not necessarily final yet.
    const selectedRelativePaths = this.filesTrees.toArray()[i].getSelectedFilePathsIncludingExtraInfo().map(x => x.path);

    // Materializes this disc's real large-file split pieces (if any), lazily, right now - this is the ONLY
    // point a large file actually gets physically split, rather than the whole job's large files all being
    // split up front before any disc is burned. The response can contain MORE entries than were requested (a
    // rare, known boundary case surfaces one extra, unplanned piece - see materializeOpticalMediaDiscPieces's
    // own comment) - that surplus piece belongs to THIS disc, since this disc's send action is what triggered
    // its file's real split, so everything below is built from the full response, not from
    // selectedRelativePaths, to make sure it's included in both the burned .ibb and the saved JSON.
    const realStats: filesMetadata[] = (await ipc.materializeOpticalMediaDiscPieces(this.backup.sourcePath, selectedRelativePaths)).res;

    /* We rename the worker's "stats" field to match what used to come from the files-tree's own "extras" -
    same shape, now real/measured instead of an estimate. We also add the volume letter, normalized to
    OPTICAL_DRIVE_LETTER_CONVENTION (see disc-id-hash.ts for why). */
    const selectedFiles = realStats.map(e => { return { "path": OPTICAL_DRIVE_LETTER_CONVENTION + e.path, "stats": e.stats } });

    // Same disc-identification hash used during recovery (see getDiscIdHash / OpticalDiscBackupDataRetriever) -
    // computed here from the exact same OPTICAL_DRIVE_LETTER_CONVENTION-prefixed paths that are about to be written
    // into the cold storage metadata JSON for this disc, so the label the user writes on the physical disc now will
    // match what the app later checks against when that disc is inserted for a recovery.
    const discIdHash = getDiscIdHash(selectedFiles.map(f => f.path).sort().toString());

    await new Promise<void>((resolve) => {
      const labelDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
      labelDialog.disableClose = true;
      labelDialog.componentInstance.title = "Disc label";
      labelDialog.componentInstance.message =
        `Please physically label this disc as disc ${i + 1}, with ID hash: ${discIdHash}. Both are needed to ` +
        `identify this disc correctly during a future recovery.`;
      labelDialog.componentInstance.actionsNum = 1;
      labelDialog.componentInstance.action1Label = "Ok";
      labelDialog.componentInstance.action1Callback = () => {
        labelDialog.close();
        resolve();
      }
    });

    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
    // Enqueue this disc's read-modify-write (see metadataUpdateQueue's own doc comment) and await its turn
    // specifically - not just whatever else is queued - so a later disc's call, enqueued after this one, can
    // never run its own read until this write has actually finished.
    await this.metadataUpdateQueue.enqueue(async () => {
      try {
        const updatedMetadataJSON: Array<Array<{ path: string; stats: any; }>> = (await ipc.readJSONfromDisk(this.coldStorageMetadataJSONPath)).res;
        updatedMetadataJSON[i] = selectedFiles;
        await ipc.writeJSONtoDisk(this.coldStorageMetadataJSONPath, JSON.stringify(updatedMetadataJSON, null, 2));
      } catch (error) {
        console.log("There is a problem with the cold storage files medadata json. Expecting array of length this._disc.")
      }
    });

    this.sentDiscPartPaths[i] = realStats.filter(e => PART_FILE_PATTERN.test(e.path)).map(e => e.path);

    this.createIBB_file(i, realStats.map(e => e.path), this.backup.sourcePath).then(()=>{
      this.sentDiscs[i] = true;
      loadingDialogRef.close();
    }).catch((error)=>{
      loadingDialogRef.close();
      const errorDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
      errorDialog.componentInstance.title = "Error";
      errorDialog.componentInstance.message = `An error occurred while creating the ImgBurn project: ${error}`;
    })
  }

  /** Marks disc i as confirmed-burned: deletes its real materialized split pieces (if any) from the temp
   *  directory, then marks it confirmed (the template grays out and disables its controls once confirmedDiscs[i]
   *  is true - see the template). Discs can be sent/confirmed in any order, independent of each other - there is
   *  no sequencing requirement, matching the already non-linear stepper "Send to ImgBurn" itself allows. */
  async confirmDiscBurned(i: number): Promise<void> {
    if (!this.sentDiscs[i] || this.confirmedDiscs[i]) { return; }
    const partRelativePaths = this.sentDiscPartPaths[i] || [];
    if (partRelativePaths.length > 0) {
      const tempDataDirectoryPath: string = (await ipc.getTempDataDirectoryPath()).res;
      const tempDirNormalized = tempDataDirectoryPath.replace(/\\$/, '');
      const piecePaths = partRelativePaths.map(p => tempDirNormalized + '\\' + p);
      await ipc.deleteMaterializedPiecesForDisc(piecePaths);
    }
    this.confirmedDiscs[i] = true;
  }

  goToHomePage(){
    this.router.navigate(['main-menu']);
  }

}
