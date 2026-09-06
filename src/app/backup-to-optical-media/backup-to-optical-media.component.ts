import { ChangeDetectorRef, Component, inject, NgZone, OnDestroy, OnInit, ViewChild, ViewChildren, QueryList } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { FilesTreeModule } from '../files-tree/files-tree.module';
import { BackupService } from '../core/services/backup/backup.service';
import { IncrementalDialogComponent } from '../incremental-dialog/incremental-dialog.component';
import { ConfirmationDialogComponent } from '../shared/components/confirmation-dialog/confirmation-dialog.component';
import { LoadingDialogComponent } from '../shared/components/loading-dialog/loading-dialog.component';
import { Subject, firstValueFrom } from 'rxjs';
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

  /** Per-disc "select all" checkbox state (one entry per disc, index-aligned with sentDiscs/confirmedDiscs) -
   *  NOT a single shared flag (fixed for real: a shared flag meant toggling "select all" on disc 2 would also
   *  visually flip disc 1's own "select all" checkbox to match, even though disc 1's actual selection - locked
   *  once sent, see sentDiscs - never changed and disc 1's checkbox is now disabled anyway). Initialized to
   *  true per disc in goToStep2 (matching createTrees()'s own initial select-all) and extended (also true) for
   *  each disc maybeAppendOverflowDiscs appends. */
  public allFilesSelected: boolean[] = [];

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
  /** This job's own temp-dir session subfolder name (see SESSION_FOLDER_NAME_PATTERN's own comment in
   *  worker.ts) - generated once (see WriteToOpticalMediaProceed) and reused for every worker call this job
   *  makes that touches the temp directory (planning, materializing split pieces, creating .ibb files), so
   *  they all agree on the exact same isolated subfolder. Never regenerated once set, even though
   *  WriteToOpticalMediaProceed can itself run again (its own "Yes, split the large files" confirmation retries
   *  it) - it is still the same logical job. */
  private tempSessionId!: string;
  /** True from the moment WriteToOpticalMediaProceed starts partitioning until the worker call actually settles
   *  (success, cancel, or error) - guards against a double-click on "Next" (nothing in the template disables
   *  that button while this is in flight) running two overlapping partition calls, which could otherwise leave
   *  tempSessionId and the eventually-assigned this.backup.opticalMediaPartitioning out of sync with each other
   *  (whichever call's session id was set last vs. whichever call's result was assigned last, independently).
   *  Deliberately does NOT block WriteToOpticalMediaProceed's own "Yes, split the large files" retry - by the
   *  time that retry runs, the failed first call has already reset this back to false. */
  private isPartitioning = false;
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
  /** True from the moment sendToImgBurn(i) starts until it's fully done (including the fire-and-forget
   *  createIBB_file chain, now awaited - see sendToImgBurn's own comment) - guards against a double-click on
   *  "Send to ImgBurn" for the SAME disc (nothing in the template disables that button while a send for it is
   *  in flight) running two overlapping sends before the first one has even written its .ibb file yet, which
   *  could otherwise trigger two concurrent real 7-Zip splits of the same large file into the same destination
   *  (materializeOpticalMediaDiscPieces's own existence check is not itself a lock). Does not block sending a
   *  DIFFERENT disc at the same time - that's fine, each disc's send is independent. */
  private sendingDiscs: boolean[] = [];
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
  /** How many discs the initial plan (partitionBackupToOpticalMedia) actually called for - fixed once
   *  goToStep2 runs, even though totalNumberOfDisksNeeded/_disks can later grow (see pendingOverflowPieces).
   *  Needed to tell "every originally-planned disc has now been sent" apart from "every disc there currently
   *  is, including ones already appended for overflow, has been sent" - see maybeAppendOverflowDiscs. */
  private originalNumberOfDisksNeeded!: number;
  /** Real, already-materialized large-file split pieces ("slivers" - see the capacity check in sendToImgBurn)
   *  that have not yet found a disc with room for them. A sliver is first offered to the disc whose "Send to
   *  ImgBurn" action produced it; if that disc is already too full, it lands here instead of immediately
   *  forcing a new disc into existence - every SUBSEQUENT original disc's send also tries to absorb whatever
   *  is still waiting here (see sendToImgBurn), so a sliver only ever actually forces a new, mostly-empty disc
   *  if it's still unclaimed once every originally-planned disc has been sent - see maybeAppendOverflowDiscs,
   *  which also tells the user their estimated disc count just changed before growing the stepper with the new
   *  disc(s). This CAN happen even so: a sliver produced by the last original disc sent has no later disc left
   *  to try. */
  private pendingOverflowPieces: filesMetadata[] = [];
  /** The selected medium's raw capacity, discounted by config.json's maxOpticalMediumRepletionRatio - see
   *  getEffectiveOpticalMediumCapacityInBytes in worker.ts. Fetched once in goToStep2 and used as the one
   *  capacity every later fit check (surplus slivers included) compares against, instead of the medium's raw
   *  selected_optical_medium.capacity. */
  private effectiveMediaCapacityInBytes!: number;

  optical_media_choices: {value: string, viewValue: string, capacity: number}[] = [
    {value: 'cd', viewValue: 'CD (700 MB)', capacity: 0.7e9},
    {value: 'dvd', viewValue: 'DVD (4.7 GB)', capacity: 4.7e9},
    {value: 'blu-ray-25', viewValue: 'Blu ray (25 GB)', capacity: 25e9},
    {value: 'blu-ray-50', viewValue: 'Blu ray (50 GB)', capacity: 50e9},
    {value: 'blu-ray-100', viewValue: 'Blu ray (100 GB)', capacity: 100e9}
  ];

  selected_optical_medium!: {value: string, viewValue: string, capacity: number};

  constructor(public router: Router, private route: ActivatedRoute, public dialog: MatDialog, public backup: BackupService, private ngZone: NgZone, private changeDetectorRef: ChangeDetectorRef) { }

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

  async goToStep2(): Promise<void> {
    this.totalNumberOfDisksNeeded = this.backup.opticalMediaPartitioning.length;
    this.originalNumberOfDisksNeeded = this.totalNumberOfDisksNeeded;
    this._disks = [...Array(this.totalNumberOfDisksNeeded).keys()];
    this.sentDiscs = Array(this.totalNumberOfDisksNeeded).fill(false);
    this.sendingDiscs = Array(this.totalNumberOfDisksNeeded).fill(false);
    this.confirmedDiscs = Array(this.totalNumberOfDisksNeeded).fill(false);
    this.sentDiscPartPaths = Array(this.totalNumberOfDisksNeeded).fill(null).map(() => []);
    this.allFilesSelected = Array(this.totalNumberOfDisksNeeded).fill(true);
    // Same effective (margin-discounted) capacity partitionBackupToOpticalMedia itself planned against - see
    // getEffectiveOpticalMediumCapacityInBytes in worker.ts. sendToImgBurn/maybeAppendOverflowDiscs must judge
    // whether a surplus sliver fits against this exact number, never the medium's raw capacity: that margin is
    // a general burn-safety feature, not something reserved for or spent by handling surplus slivers.
    this.effectiveMediaCapacityInBytes = (await ipc.getEffectiveOpticalMediumCapacity(this.selected_optical_medium.capacity)).res;
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

      // Guards against a double-click on "Next" (see isPartitioning's own doc comment) running two overlapping
      // partition calls - not against the intentional "Yes, split the large files" retry below, which only
      // ever runs after this flag has already been reset to false by the failed first call.
      if (this.isPartitioning) { return; }

      if (this.backup.sourcePath && this.selected_optical_medium && this.coldStorageCollectionName.trim()) {
        // Generated once per job, even though this method can run again (its own "Yes, split the large files"
        // confirmation below retries it) - see tempSessionId's own doc comment for why that retry must NOT get
        // a fresh id of its own.
        if (!this.tempSessionId) { this.tempSessionId = 'session-' + Date.now(); }
        this.isPartitioning = true;

        const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
        let promise = ipc.partitionBackupToOpticalMedia(this.backup.sourcePath, this.selected_optical_medium.capacity, this.splitLargeFiles, this.tempSessionId);

        promise.then((response)=>{
          this.isPartitioning = false;

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
          // "Estimated": the real count can still grow later, in the rare case a large file's real split turns
          // out to need one more piece than planning predicted and that surplus doesn't fit on the disc that
          // triggers it - see maybeAppendOverflowDiscs, which is what actually updates the count if that happens.
          const info_msg = `To burn the backup to the optical medium of your choice (${this.selected_optical_medium.viewValue}) you will need an estimated ${response.res.length} discs in total.`
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
          this.isPartitioning = false;
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
                // This job's own session subfolder (see tempSessionId's own doc comment) - appended AFTER the
                // trailing-backslash fix above (not before), so the same fix also covers the boundary between
                // the root and this segment. Everything downstream (trimming predicted piece paths, the later
                // materialize/createIBB_file/confirmDiscBurned calls) treats this combined path as simply "the"
                // temp directory for this job - it is never mixed up with the bare root elsewhere in this file.
                this.tempDataDirectoryPath += this.tempSessionId + '\\';
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

    await this.goToStep2();
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
    // updated it after its initial `= true` declaration). Indexed by disc (see allFilesSelected's own doc
    // comment) so toggling one disc's checkbox can never visually affect a different disc's.
    this.allFilesSelected[i] = selected;
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
    await ipc.createIBB_file(disk_id, paths, sourcePath, this.tempSessionId, volumeLabel);
  }

  async sendToImgBurn(i: number){
    // Guards against a double-click on "Send to ImgBurn" for this SAME disc (see sendingDiscs's own doc
    // comment) - not against sending a different disc at the same time, which is independent and fine. The
    // whole method body is wrapped so the guard covers the once-fired-and-forgotten createIBB_file chain too
    // (now awaited below) - resetting the flag before that had actually finished would reopen the exact
    // narrow window (no .ibb written yet) this guard exists to close.
    if (this.sendingDiscs[i]) { return; }
    this.sendingDiscs[i] = true;
    try {
      // If this disc was already sent once during this job, its .ibb project file already exists under this
      // job's own session subfolder - just reopen ImgBurn on that exact, untouched file instead of recomputing
      // the selection, re-materializing pieces, and rewriting the metadata JSON (see
      // openExistingIBBFileInImgBurn's own comment in worker.ts for why redoing all of that on a resend is
      // risky). Nothing else below needs to run in that case - the disc is already fully recorded from its first
      // send.
      if ((await ipc.openExistingIBBFile(this.tempSessionId, i)).res.opened) {
        return;
      }

      // The bare-relative (relative to this.backup.sourcePath) paths currently selected in this disc's tree -
      // this is the plan's ESTIMATE for any large-file split piece among them (see estimateLargeFileSplitPieces
      // in worker.ts): a piece's path is already correctly predicted, but its size is not necessarily final yet.
      const selectedRelativePaths = this.filesTrees.toArray()[i].getSelectedFilePathsIncludingExtraInfo().map(x => x.path);

      // No disc this app ever creates - neither an originally-planned one (partitionBackupToOpticalMedia never
      // produces an empty partition) nor an overflow one (maybeAppendOverflowDiscs only ever appends non-empty
      // partitions) - should legitimately have zero files selected here. Seen once for real (a one-off, never
      // reproduced across 5 further attempts): disc 3, freshly appended by maybeAppendOverflowDiscs, sent with
      // nothing selected - burning it anyway would have silently produced a useless, empty .ibb and left its real
      // piece file undeleted forever (confirmDiscBurned only deletes what sentDiscPartPaths recorded, which would
      // also be empty). Fail loudly and let the user retry instead - by the time they click again, whatever
      // timing issue caused this (this disc's tree still finishing being seeded, most likely) has almost
      // certainly resolved.
      if (selectedRelativePaths.length === 0) {
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `Disc ${i + 1} has no files selected to send - this should never happen. Please try clicking "Send to ImgBurn" again.`;
        errorDialog.componentInstance.actionsNum = 1;
        errorDialog.componentInstance.action1Label = "Ok";
        errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); };
        return;
      }

      // Materializes this disc's real large-file split pieces (if any), lazily, right now - this is the ONLY
      // point a large file actually gets physically split, rather than the whole job's large files all being
      // split up front before any disc is burned. The response can contain MORE entries than were requested (a
      // rare, known boundary case surfaces one extra, unplanned "sliver" piece - see
      // materializeOpticalMediaDiscPieces's own comment): whichever disc's send action happens to trigger a
      // given large file's real split is offered that file's sliver first, purely as a byproduct of triggering
      // the split - not because it's guaranteed to belong there. Whether it actually ends up on THIS disc is
      // decided below, by the capacity check.
      const realStats: filesMetadata[] = (await ipc.materializeOpticalMediaDiscPieces(this.backup.sourcePath, selectedRelativePaths, this.tempSessionId)).res;

      // Split the response back into what this disc's tree actually asked for and any surplus sliver(s) riding
      // along with it (see materializeOpticalMediaDiscPieces's own comment).
      const requestedPaths = new Set(selectedRelativePaths);
      const normalStats = realStats.filter(e => requestedPaths.has(e.path));
      const ownSurplusStats = realStats.filter(e => !requestedPaths.has(e.path));
      let discUsedBytes = normalStats.reduce((sum, e) => sum + e.stats.size, 0);
      const finalStats = normalStats.slice();

      // A surplus piece is accepted onto THIS disc only if the disc's total real, materialized size still fits
      // within effectiveMediaCapacityInBytes - the SAME margin-discounted capacity partitionBackupToOpticalMedia
      // planned every disc against (see getEffectiveOpticalMediumCapacityInBytes in worker.ts), never the
      // medium's raw capacity: that margin is a general burn-safety feature that applies to everything written
      // to a disc, not something reserved for or spent by surplus slivers specifically.
      //
      // The candidates tried here are this disc's own fresh surplus AND any sliver an EARLIER disc's send
      // already produced but couldn't fit at the time (pendingOverflowPieces) - not just the former. Without
      // this, a sliver rejected by disc 1 would sit untouched until every original disc is sent and then get a
      // brand new, almost entirely empty disc all to itself, even if disc 2 (sent right after, with real
      // content of its own and room to spare) could easily have carried it. Trying the accumulated backlog on
      // every subsequent disc's send - oldest first, so a longer-waiting piece isn't starved by a newer one -
      // means a new disc only ever gets created for whatever still doesn't fit anywhere once every original
      // disc has actually been sent (see maybeAppendOverflowDiscs). This can't eliminate the case entirely: a
      // sliver produced by the LAST original disc sent has no later disc left to offer it to.
      const candidateSurplusPieces = this.pendingOverflowPieces.concat(ownSurplusStats);
      this.pendingOverflowPieces = [];
      for (const surplusPiece of candidateSurplusPieces) {
        if (discUsedBytes + surplusPiece.stats.size <= this.effectiveMediaCapacityInBytes) {
          discUsedBytes += surplusPiece.stats.size;
          finalStats.push(surplusPiece);
        } else {
          this.pendingOverflowPieces.push(surplusPiece);
        }
      }

      /* We rename the worker's "stats" field to match what used to come from the files-tree's own "extras" -
      same shape, now real/measured instead of an estimate. We also add the volume letter, normalized to
      OPTICAL_DRIVE_LETTER_CONVENTION (see disc-id-hash.ts for why). */
      const selectedFiles = finalStats.map(e => { return { "path": OPTICAL_DRIVE_LETTER_CONVENTION + e.path, "stats": e.stats } });

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

      this.sentDiscPartPaths[i] = finalStats.filter(e => PART_FILE_PATTERN.test(e.path)).map(e => e.path);

      // Awaited (previously fired-and-forgotten): see sendingDiscs's own doc comment for why this guard needs
      // this chain's real completion, not just its start, to reset on.
      await this.createIBB_file(i, finalStats.map(e => e.path), this.backup.sourcePath).then(async ()=>{
        this.sentDiscs[i] = true;
        loadingDialogRef.close();
        // Now that this disc has actually been sent, check whether every originally-planned disc has (so no
        // further surplus slivers can still turn up) and, if pendingOverflowPieces is non-empty, append however
        // many extra discs are needed to burn them too - see maybeAppendOverflowDiscs's own comment.
        await this.maybeAppendOverflowDiscs();
      }).catch((error)=>{
        loadingDialogRef.close();
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `An error occurred while creating the ImgBurn project: ${error}`;
      })
    } finally {
      this.sendingDiscs[i] = false;
    }
  }

  /** Once every originally-planned disc has been sent to ImgBurn (so no more surplus slivers can still turn
   *  up - see the capacity check in sendToImgBurn), packs any pendingOverflowPieces onto one or more freshly
   *  appended discs so the user still gets to burn them, using a plain sequential-fill packer (these are at
   *  most a handful of tiny sliver pieces - the sophistication of partitionBackupToOpticalMedia's own
   *  First-Fit-Decreasing packer buys nothing here). By the time this runs, most slivers have usually already
   *  been absorbed into a later original disc's own send (see the candidateSurplusPieces handling in
   *  sendToImgBurn) - this is the last resort for whatever is still left over once there is no later original
   *  disc left to offer it to. Each new disc goes through the exact same
   *  select-files/"Send to ImgBurn"/"Confirm disc burned" lifecycle as any other - the pieces are already real,
   *  materialized files by this point, so selecting and sending one merely re-discovers it as "already
   *  materialized" (see materializeOpticalMediaDiscPieces), it is never split again.
   *
   *  This does mean the user can end up burning more discs than the number they were originally told they'd
   *  need up front - an acceptable outcome of an already very rare case, but the user is told about it (see
   *  the info dialog below) before the stepper grows, rather than just finding an extra step has appeared.
   *
   *  Safe to call after every disc send; it only does anything the first time both conditions are true, since
   *  draining pendingOverflowPieces here is what stops it from doing anything again for the same pieces. */
  private async maybeAppendOverflowDiscs(): Promise<void> {
    const everyOriginalDiscSent = this.sentDiscs.slice(0, this.originalNumberOfDisksNeeded).every(sent => sent);
    if (!everyOriginalDiscSent || this.pendingOverflowPieces.length === 0) {
      return;
    }

    const overflowPartitions: filesMetadata[][] = [];
    let currentPartition: filesMetadata[] = [];
    let currentPartitionBytes = 0;
    for (const piece of this.pendingOverflowPieces) {
      if (currentPartition.length > 0 && currentPartitionBytes + piece.stats.size > this.effectiveMediaCapacityInBytes) {
        overflowPartitions.push(currentPartition);
        currentPartition = [];
        currentPartitionBytes = 0;
      }
      currentPartition.push(piece);
      currentPartitionBytes += piece.stats.size;
    }
    if (currentPartition.length > 0) {
      overflowPartitions.push(currentPartition);
    }
    this.pendingOverflowPieces = [];

    const previousTotal = this.totalNumberOfDisksNeeded;
    const newTotal = previousTotal + overflowPartitions.length;

    // Tell the user before the stepper grows underneath them, not after - a new step silently appearing in the
    // list would be a far more confusing way to find out the estimate changed than being told upfront why it
    // did. Only "Ok" is offered (nothing to decide here - the extra disc(s) need burning regardless).
    await new Promise<void>((resolve) => {
      const infoDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
      infoDialog.disableClose = true;
      infoDialog.componentInstance.title = "Disc count updated";
      infoDialog.componentInstance.message =
        `The estimated number of discs needed has changed: it was ${previousTotal}, but a rare file-splitting ` +
        `edge case means ${overflowPartitions.length} more disc(s) are needed to fit everything. You will now ` +
        `need ${newTotal} discs in total.`;
      infoDialog.componentInstance.actionsNum = 1;
      infoDialog.componentInstance.action1Label = "Ok";
      infoDialog.componentInstance.action1Callback = () => {
        infoDialog.close();
        resolve();
      }
    });

    const firstNewDiscIndex = this.totalNumberOfDisksNeeded;
    for (const partition of overflowPartitions) {
      this.backup.opticalMediaPartitioning.push(partition);
      this.sentDiscs.push(false);
      this.sendingDiscs.push(false);
      this.confirmedDiscs.push(false);
      this.sentDiscPartPaths.push([]);
      this.allFilesSelected.push(true);
    }
    this.totalNumberOfDisksNeeded = newTotal;
    this._disks = [...Array(this.totalNumberOfDisksNeeded).keys()];

    // Wait for the newly appended mat-step/files-tree elements (one per new disc index just added to _disks)
    // to actually mount before populating them - filesTrees (a QueryList) only reflects the new DOM after
    // Angular re-checks the view, which detectChanges forces synchronously right here rather than waiting on
    // zone.js to get around to it on its own.
    const treesMounted = firstValueFrom(this.filesTrees.changes);
    this.changeDetectorRef.detectChanges();
    await treesMounted;

    const treesArray = this.filesTrees.toArray();
    for (let discIndex = firstNewDiscIndex; discIndex < this.totalNumberOfDisksNeeded; discIndex++) {
      const partition = this.backup.opticalMediaPartitioning[discIndex];
      await treesArray[discIndex].setTreeData(partition.map(x => x.path), partition.map(x => x.stats));
      treesArray[discIndex].expandAllNodes();
      treesArray[discIndex].selectAllNodes();
    }
  }

  /** Marks disc i as confirmed-burned: deletes its real materialized split pieces (if any) from the temp
   *  directory, then marks it confirmed (the template grays out and disables its controls once confirmedDiscs[i]
   *  is true - see the template). Discs can be sent/confirmed in any order, independent of each other - there is
   *  no sequencing requirement, matching the already non-linear stepper "Send to ImgBurn" itself allows. */
  async confirmDiscBurned(i: number): Promise<void> {
    if (!this.sentDiscs[i] || this.confirmedDiscs[i]) { return; }
    const partRelativePaths = this.sentDiscPartPaths[i] || [];
    if (partRelativePaths.length > 0) {
      // This job's own session subfolder (see tempSessionId's own doc comment) - the same one materialize
      // actually wrote these real pieces under, not the temp directory's bare root.
      const rawTempDataDirectoryPath: string = (await ipc.getTempDataDirectoryPath()).res;
      const tempDirNormalized = rawTempDataDirectoryPath.replace(/\\$/, '') + '\\' + this.tempSessionId;
      const piecePaths = partRelativePaths.map(p => tempDirNormalized + '\\' + p);
      await ipc.deleteMaterializedPiecesForDisc(piecePaths);
    }
    this.confirmedDiscs[i] = true;
  }

  goToHomePage(){
    this.router.navigate(['main-menu']);
  }

}
