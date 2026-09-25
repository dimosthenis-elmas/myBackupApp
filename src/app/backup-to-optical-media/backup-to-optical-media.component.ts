import { ChangeDetectorRef, Component, inject, NgZone, OnDestroy, OnInit, ViewChild, ViewChildren, QueryList } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { FilesTreeModule } from '../files-tree/files-tree.module';
import { BackupService } from '../core/services/backup/backup.service';
import { IncrementalDialogComponent } from '../incremental-dialog/incremental-dialog.component';
import { ConfirmationDialogComponent } from '../shared/components/confirmation-dialog/confirmation-dialog.component';
import { LoadingDialogComponent } from '../shared/components/loading-dialog/loading-dialog.component';
import { Subject, firstValueFrom } from 'rxjs';
import { WorkerCommunicator as ipc } from '../../../app/workers/worker-communicator'
import { OPTICAL_DRIVE_LETTER_CONVENTION } from '../shared/utils/disc-id-hash';
import { WorkerListener, WorkerResponse } from '../../../app/workers/ipc.interfaces';
import { filesMetadata } from '../../types/interface';
import { SerialQueue } from '../shared/utils/serial-queue';
import { PART_FILE_PATTERN } from '../shared/utils/part-file-pattern';
import { linkedDiscGroup, discsLabel, linkedDiscsNoticeMessage } from '../shared/utils/linked-discs';
import { OPTICAL_MEDIA, OpticalMedium } from '../shared/utils/optical-media';
import { goToMainMenuAndReload } from '../shared/utils/go-to-main-menu';
import { parseScanItemsProgress, parsePackingProgress } from '../shared/utils/progress-line';

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
  
  private tempDataDirectoryPath!: string;
  /** This job's own temp-dir session subfolder name (see SESSION_FOLDER_NAME_PATTERN's own comment in
   *  worker.ts) - generated once (see WriteToOpticalMediaProceed) and reused for every worker call this job
   *  makes that touches the temp directory (planning, creating split partials, creating .ibb files), so
   *  they all agree on the exact same isolated subfolder. Never regenerated once set, even though
   *  WriteToOpticalMediaProceed can itself run again (its own "Yes, split the large files" confirmation retries
   *  it) - it is still the same logical job. */
  private tempSessionId!: string;
  /** True from the moment WriteToOpticalMediaProceed starts partitioning until the worker call actually settles
   *  (success, cancel, or error) - guards against a double-click on "Next" (also bound to the template's own
   *  [disabled] on that button, so this is a backstop, not the only thing preventing it) running two overlapping
   *  partition calls, which could otherwise leave tempSessionId and the eventually-assigned
   *  this.backup.opticalMediaPartitioning out of sync with each other (whichever call's session id was set last
   *  vs. whichever call's result was assigned last, independently). Deliberately does NOT block
   *  WriteToOpticalMediaProceed's own "Yes, split the large files" retry - by the time that retry runs, the
   *  failed first call has already reset this back to false. Public so the template can bind to it. */
  public isPartitioning = false;
  /** Full path (folder + file name), chosen by the user via a save dialog, where the cold storage metadata
   * JSON is written/updated for this session. See chooseSaveFile(). */
  private coldStorageMetadataJSONPath!: string;
  /** Serializes recordConfirmedDiscs' read-modify-write of the shared cold storage metadata JSON - see SerialQueue's
   *  own doc comment for why this is needed (the stepper is non-linear, so discs can be confirmed in quick
   *  succession, in any order). */
  private metadataUpdateQueue = new SerialQueue();
  /** Disc i's entry for the cold storage metadata JSON - its files with their real sizes and hashes - made when it is
   *  sent to ImgBurn, and written to the JSON only once it is confirmed burned (see recordConfirmedDiscs). */
  private discMetadataEntries: Array<Array<{ path: string; stats: any }> | undefined> = [];
  /** Whether disc i's entry has been written to the cold storage metadata JSON - see recordConfirmedDiscs. */
  private recordedDiscs: boolean[] = [];
  /** Whether disc i has been sent to ImgBurn at least once yet - gates both "Confirm disc burned" (can't
   *  confirm a disc that was never sent) and re-sending. */
  public sentDiscs: boolean[] = [];
  /** True from the moment sendToImgBurn(i) starts until it's fully done (including the fire-and-forget
   *  createIBB_file chain, now awaited - see sendToImgBurn's own comment) - guards against a double-click on
   *  "Send to ImgBurn" for the SAME disc (also bound to that button's own [disabled] in the template, so this
   *  is a backstop, not the only thing preventing it) running two overlapping sends before the first one has
   *  even written its .ibb file yet, which could otherwise trigger two concurrent real 7-Zip splits of the same
   *  large file into the same destination (createOpticalMediaDiscPartials's own existence check is not
   *  itself a lock). Does not block sending a DIFFERENT disc at the same time - that's fine, each disc's send
   *  is independent. Public so the template can bind to it. */
  public sendingDiscs: boolean[] = [];
  /** Whether the user has confirmed disc i was actually burned - see confirmDiscBurned(). Intentionally pure
   *  in-memory state, never persisted: if the app closes mid-job, the user starts over. That is an explicit
   *  decision (no resume support), not an oversight - please don't "fix" this into a persistence feature. */
  public confirmedDiscs: boolean[] = [];
  /** For each disc i, the bare-relative (relative to this.backup.sourcePath) large-file-split-partial paths that
   *  were actually created and burned for that disc - captured once in sendToImgBurn, since it can include
   *  a rare surplus partial (a "sliver" - see createOpticalMediaDiscPartials) that was never part of the tree's own
   *  selection and so cannot be recovered later by re-querying the tree. confirmDiscBurned reads this to know
   *  exactly which real temp-dir files to delete. */
  private sentDiscPartPaths: string[][] = [];
  /** Name of this cold storage collection of discs, provided once by the user in step_1 and burned onto every
   * disc's UDF volume label as "<name> Disc <N>" (see sendToImgBurn/createIBB_file) - so all discs from the
   * same backup carry a recognizable, shared label. */
  public coldStorageCollectionName: string = '';
  /** How many discs the initial plan (partitionBackupToOpticalMedia) actually called for - fixed once
   *  goToStep2 runs, even though totalNumberOfDisksNeeded/_disks can later grow (see pendingOverflowPartials).
   *  Needed to tell "every originally-planned disc has now been sent" apart from "every disc there currently
   *  is, including ones already appended for overflow, has been sent" - see maybeAppendOverflowDiscs. */
  private originalNumberOfDisksNeeded!: number;
  /** Real, already-created large-file split partials ("slivers" - see the capacity check in sendToImgBurn)
   *  that have not yet found a disc with room for them. A sliver is first offered to the disc whose "Send to
   *  ImgBurn" action produced it; if that disc is already too full, it lands here instead of immediately
   *  forcing a new disc into existence - every SUBSEQUENT original disc's send also tries to absorb whatever
   *  is still waiting here (see sendToImgBurn), so a sliver only ever actually forces a new, mostly-empty disc
   *  if it's still unclaimed once every originally-planned disc has been sent - see maybeAppendOverflowDiscs,
   *  which also tells the user their estimated disc count just changed before growing the stepper with the new
   *  disc(s). This CAN happen even so: a sliver produced by the last original disc sent has no later disc left
   *  to try. */
  private pendingOverflowPartials: filesMetadata[] = [];
  /** The selected medium's raw capacity, discounted by its maxRepletionRatio (see OPTICAL_MEDIA) - see
   *  getEffectiveOpticalMediumCapacityInBytes in worker.ts. Fetched once in goToStep2 and used as the one
   *  capacity every later fit check (surplus slivers included) compares against, instead of the medium's raw
   *  selected_optical_medium.capacity. */
  private effectiveMediaCapacityInBytes!: number;

  optical_media_choices = OPTICAL_MEDIA;

  selected_optical_medium!: OpticalMedium;

  constructor(public router: Router, private route: ActivatedRoute, public dialog: MatDialog, public backup: BackupService, private ngZone: NgZone, private changeDetectorRef: ChangeDetectorRef) { }

  ngOnInit(): void {
    
  }

  ngAfterViewInit(): void {
    //console.log(this.filesTrees.toArray());
    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
    loadingDialogRef.componentInstance.message = 'Building files tree';

    this.createTrees(loadingDialogRef).then(()=>{
      loadingDialogRef.close();
    })

    loadingDialogRef.afterClosed().subscribe(result => {
      if(result == false){
        console.log("Sending stop")
        ipc.stop();
        goToMainMenuAndReload(this.router);
      }
    });

  }

  goToMainMenu(){
    goToMainMenuAndReload(this.router);
  }

  async goToStep2(): Promise<void> {
    this.totalNumberOfDisksNeeded = this.backup.opticalMediaPartitioning.length;
    this.originalNumberOfDisksNeeded = this.totalNumberOfDisksNeeded;
    this._disks = [...Array(this.totalNumberOfDisksNeeded).keys()];
    this.sentDiscs = Array(this.totalNumberOfDisksNeeded).fill(false);
    this.sendingDiscs = Array(this.totalNumberOfDisksNeeded).fill(false);
    this.confirmedDiscs = Array(this.totalNumberOfDisksNeeded).fill(false);
    this.sentDiscPartPaths = Array(this.totalNumberOfDisksNeeded).fill(null).map(() => []);
    this.discMetadataEntries = Array(this.totalNumberOfDisksNeeded).fill(undefined);
    this.recordedDiscs = Array(this.totalNumberOfDisksNeeded).fill(false);
    this.allFilesSelected = Array(this.totalNumberOfDisksNeeded).fill(true);
    // Same effective (margin-discounted) capacity partitionBackupToOpticalMedia itself planned against - see
    // getEffectiveOpticalMediumCapacityInBytes in worker.ts. sendToImgBurn/maybeAppendOverflowDiscs must judge
    // whether a surplus sliver fits against this exact number, never the medium's raw capacity: that margin is
    // a general burn-safety feature, not something reserved for or spent by handling surplus slivers.
    this.effectiveMediaCapacityInBytes = (await ipc.getEffectiveOpticalMediumCapacity(this.selected_optical_medium.capacity, this.selected_optical_medium.maxRepletionRatio)).res;
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
        loadingDialogRef.componentInstance.message = 'Planning discs';
        // Real 0-100% across both of partitionBackupToOpticalMedia's phases - a scan of sourcePath (0-50%,
        // "Scanning items (i of N)" against countAllFilesQuick's upfront probe - see worker.ts) then the
        // bin-packing loop itself (50-100%, "Packing items (i of N)", one disc at a time). See the identical
        // diffProgressListener pattern in incremental.component.ts/sync-dirs.component.ts.
        const partitionProgressListener = ipc.onResponseFromWorker((event, response) => {
          this.ngZone.run(() => {
            if (response.key === 'partition-backup-to-optical-media' && response.status === 'running') {
              const lines = response.res as string[];
              for (const line of lines) {
                const scanProgress = parseScanItemsProgress(line);
                const packProgress = parsePackingProgress(line);
                if (scanProgress) {
                  loadingDialogRef.componentInstance.percent = Math.round((scanProgress.current / scanProgress.total) * 50);
                } else if (packProgress) {
                  loadingDialogRef.componentInstance.percent = 50 + Math.round((packProgress.current / packProgress.total) * 50);
                }
              }
            }
          });
        });
        // filesMetadata undefined (the worker scans sourcePath itself), skipUnreadable true: an entry in the backup
        // source that cannot be read is left out and reported, rather than making the whole planning fail.
        let promise = ipc.partitionBackupToOpticalMedia(this.backup.sourcePath, this.selected_optical_medium.capacity, this.selected_optical_medium.maxRepletionRatio, this.splitLargeFiles, this.tempSessionId, undefined, true);

        promise.then((response)=>{
          this.isPartitioning = false;
          partitionProgressListener.removeListener();

          if(response.status == "completed"){
  
          console.log(JSON.stringify(response));
          
          /* the response from the worker returns the full paths relative to the host file system.
           Since we are indifferent for the full system file structure we trim the 'this.backup.sourcePath'
           part from all paths. This way our root becomes the directory chosen by the user in the dialog.*/
          // Ending in exactly one backslash: the folder picker returns a drive root ("D:\") with its backslash
          // already, so appending another would never match the paths found under it.
          const sourcePathPrefix = this.backup.sourcePath.endsWith('\\') ? this.backup.sourcePath : this.backup.sourcePath + '\\';
          let opticalDiskPartitioningTrimmed = response.res.map(
            (subarray)=>{
              return subarray.map(x=>{
                x.path = x.path.replace(sourcePathPrefix, "");
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
          // out to need one more partial than planning predicted and that surplus doesn't fit on the disc that
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
          partitionProgressListener.removeListener();
          console.log(JSON.stringify(err));
          loadingDialogRef.close();

          // Optional chaining: not every rejection is a full worker response (e.g. a cancelled queued request
          // rejects with a plain string), and reading err.res.err_code off one of those would itself throw.
          if(err?.res?.err_code == 'FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC'){
            const confirmDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '700px'});
            confirmDialog.disableClose = true;
            // Every too-large file, by full path, as a scrollable list - there can be many. err.res.msg (a one-line
            // summary naming only the first one) is the fallback for a response without the list.
            const tooLargeFiles: Array<{ path: string, size: number }> = Array.isArray(err.res.too_large_files) ? err.res.too_large_files : [];
            confirmDialog.componentInstance.message =
              (tooLargeFiles.length > 0
                ? `${tooLargeFiles.length} file(s) are too large to fit on any single ${this.selected_optical_medium.viewValue} disc - see the list below.`
                : `${err.res.msg}`) +
              `\n\nBut wait, there might be a fix to this! This app can split each of those files into 500 MB parts ` +
              `and write the parts to the discs like any other file. For example, a large file myFile.zip becomes ` +
              `myFile.zip.part.001, myFile.zip.part.002 and so on, in the same folder. When you recover the data, the ` +
              `app offers to reassemble the original file from its parts. Would you like to proceed with this approach?`;
            if (tooLargeFiles.length > 0) {
              confirmDialog.componentInstance.lists = [{ label: `Too large for a single disc (${tooLargeFiles.length}):`, items: tooLargeFiles.map(f => f.path) }];
            }
            confirmDialog.componentInstance.title = "Large files found"
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
                // right above, in the un-split trim a few lines up) - without it, a split partial's real path
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
                // the root and this segment. Everything downstream (trimming predicted partial paths, the later
                // create/createIBB_file/confirmDiscBurned calls) treats this combined path as simply "the"
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
              errorDialog.componentInstance.message = `${err}`;
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

    loadingDialogRef.componentInstance.message = 'Building files tree';
    this.createTrees(loadingDialogRef).then(()=>{
      loadingDialogRef.close();
    })

    loadingDialogRef.afterClosed().subscribe(result => {
      if(result == false){
        console.log("Sending stop")
        ipc.stop();
        goToMainMenuAndReload(this.router);
      }
    });
  }


  /** Builds every disc's <files-tree> from the already-known opticalMediaPartitioning (no disk I/O - just
   *  turning already-planned data into displayed trees), behind `loadingDialogRef`'s real percentage: each
   *  tree's own buildProgress (0-100, see FilesTreeComponent.setTreeData) is weighted into its own equal 1/N
   *  slice of the overall 0-100 range, so multiple trees still add up to one smoothly climbing bar instead of
   *  restarting from 0 (or just sitting on a plain spinner, as this used to) once per disc. */
  async createTrees(loadingDialogRef: MatDialogRef<LoadingDialogComponent>):Promise<void> {
    const trees = this.filesTrees.toArray();
    for (let i = 0; i < trees.length; i++) {
      const treeStart = Math.round((i / trees.length) * 100);
      const treeEnd = Math.round(((i + 1) / trees.length) * 100);
      const progressSubscription = trees[i].buildProgress.subscribe((percent) => {
        loadingDialogRef.componentInstance.percent = treeStart + Math.round((percent / 100) * (treeEnd - treeStart));
      });
      try {
        await trees[i].setTreeData(
          this.backup.opticalMediaPartitioning[i].map(x=>{return x.path}),
          this.backup.opticalMediaPartitioning[i].map(x=>{return x.stats}));
      } finally {
        progressSubscription.unsubscribe();
      }
      trees[i].expandAllNodes();
      trees[i].selectAllNodes();
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

    // A failure to START ImgBurn is not reported through this call: the worker shows it as an error dialog of its
    // own (see invokeImgBurnOnIBBFile in worker.ts), and clicking "Send to ImgBurn" again reopens the same .ibb file.
    // ipc.createIBB_file() resolves once the worker has finished building the .ibb file and invoking ImgBurn.
    await ipc.createIBB_file(disk_id, paths, sourcePath, this.tempSessionId, volumeLabel);
  }

  /** Computes and attaches a `sha256` hash to every non-directory entry of `finalStats` (mutated in place) -
   *  see computeSha256ForBackedUpFiles in worker.ts. Must be called after createOpticalMediaDiscPartials has
   *  already produced this disc's real, final file list (every entry must already exist on disk), and before
   *  anything else about this disc (its label hash, its metadata JSON entry, its .ibb file) is computed from
   *  that list. Shows its own progress dialog, driven by this same worker channel's `running` pushes - just a
   *  real percentage (LoadingDialogComponent's `percent`, derived from how many files have been hashed so far
   *  out of hashableEntries.length). Deliberately not the accumulating `lines` scrolling list (which reserves
   *  a fixed 220px box regardless of content - way too much real estate for what's usually a handful of
   *  files). Always runs - SHA-256
   *  integrity data is mandatory, not a toggle (there used to be a "File integrity data" option offered
   *  alongside collection name at step 1, since removed): every file backed up gets a recorded hash so a later
   *  recovery, or the standalone "verify integrity of cold storage disc" wizard, can check its bytes weren't
   *  silently corrupted (a drive read error, disc handling damage) independent of the optical medium's own
   *  error correction. A no-op when finalStats has no non-directory entries. */
  private async attachSha256HashesToDiscFiles(finalStats: filesMetadata[]): Promise<void> {
    const hashableEntries = finalStats.filter(e => !e.stats.isDirectory);
    if (hashableEntries.length === 0) { return; }

    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
    loadingDialogRef.componentInstance.showCancelButton = false;
    loadingDialogRef.componentInstance.message = "Calculating SHA-256 hashes";    let hashedCount = 0;
    const listener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        if (response.key === 'compute-sha256-for-backed-up-files' && response.status === 'running') {
          const newLines = response.res as string[];
          hashedCount += newLines.length;
          loadingDialogRef.componentInstance.percent = Math.round((hashedCount / hashableEntries.length) * 100);
        }
      });
    });
    try {
      const hashResults: Array<{ path: string, sha256: string }> =
        (await ipc.computeSha256ForBackedUpFiles(this.backup.sourcePath, hashableEntries.map(e => e.path), this.tempSessionId)).res;
      const hashByPath = new Map(hashResults.map(r => [r.path, r.sha256]));
      hashableEntries.forEach(e => {
        const hash = hashByPath.get(e.path);
        if (hash) { e.stats.sha256 = hash; }
      });
    } finally {
      listener.removeListener();
      loadingDialogRef.close();
    }
  }

  /** How a rare split-partial "sliver" is handled, end to end - this is the answer to "the files tree shows N
   *  partials but 7-Zip actually produced N+1 real partials, what happens?":
   *
   *  Why the discrepancy happens at all: planning (partitionBackupToOpticalMedia) never runs 7-Zip - it only
   *  predicts split partials arithmetically (estimateLargeFileSplitPartials in worker.ts), assuming each partial is
   *  exactly LARGE_FILE_SPLIT_VOLUME_SIZE_MIB. The real 7-Zip split only happens later, lazily, the first time
   *  some disc is actually sent to ImgBurn (createOpticalMediaDiscPartials in worker.ts). In a rare boundary
   *  case, the real split produces exactly one more partial than the estimate predicted - a "sliver."
   *
   *  What happens when the user clicks "Send to ImgBurn":
   *   1. createOpticalMediaDiscPartials runs the real 7z split for that file and compares the real partial
   *      count to the estimate: equal means nothing special; real = estimate + 1 means the extra partial is
   *      appended to the response as a surplus/sliver, reported once, by whichever disc's send happened to
   *      trigger the split; any other mismatch throws, telling the user to redo planning.
   *   2. Below, the response is split into normalStats (what the tree asked for) and the sliver. The sliver is
   *      offered to that same disc first: if it still fits under the effective (margin-discounted) capacity,
   *      it's silently folded into finalStats for that disc - burned into its .ibb, written into that disc's
   *      slot in the cold-storage metadata JSON, and recorded in sentDiscPartPaths[i] (so "Confirm disc burned"
   *      later deletes it too).
   *   3. If it doesn't fit, it goes into pendingOverflowPartials and gets offered to every subsequent original
   *      disc's own send in turn. Only once every originally-planned disc has been sent does
   *      maybeAppendOverflowDiscs pack whatever's still unclaimed onto one or more brand-new appended discs -
   *      with a "Disc count updated" dialog telling the user the total disc count just grew, then mounting new
   *      files-tree steps, pre-selected, for those.
   *
   *  Does the displayed tree update? No - deliberately not. The tree the user sees for that disc still shows
   *  only the N partials they originally selected, never the extra real partial. That extra partial is real
   *  (physically split, burned, tracked for later cleanup) but invisible in that disc's tree UI.
   *  sentDiscPartPaths's own doc comment says this explicitly: the sliver "was never part of the tree's own
   *  selection and so cannot be recovered later by re-querying the tree" - which is exactly why
   *  sentDiscPartPaths exists as separate bookkeeping outside the tree component at all. So: the files tree
   *  stays at its original count in the UI, but the actual burned disc and its metadata JSON entry correctly
   *  contain the real count. The only user-visible signal of any of this is the "Disc count updated" dialog,
   *  and only if the sliver overflows all the way to needing a brand-new disc - the common sub-case (it fits
   *  on the same or a later disc) is completely silent. */
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
      // the selection, re-creating partials, and rewriting the metadata JSON (see
      // openExistingIBBFileInImgBurn's own comment in worker.ts for why redoing all of that on a resend is
      // risky). Nothing else below needs to run in that case - the disc is already fully recorded from its first
      // send.
      //
      // Wrapped in its own try/catch (unlike every other await below, which lets a rejection fall through to
      // the finally block and out of this method) because a rejection here used to fail completely silently -
      // no dialog, nothing but a console warning - since nothing else in this method would have caught it either.
      try {
        if ((await ipc.openExistingIBBFile(this.tempSessionId, i)).res.opened) {
          return;
        }
      } catch (error) {
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `Could not check whether disc ${i + 1} was already sent: ${error}`;
        errorDialog.componentInstance.actionsNum = 1;
        errorDialog.componentInstance.action1Label = "Ok";
        errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); };
        return;
      }

      // The bare-relative (relative to this.backup.sourcePath) paths currently selected in this disc's tree -
      // this is the plan's ESTIMATE for any large-file split partial among them (see estimateLargeFileSplitPartials
      // in worker.ts): a partial's path is already correctly predicted, but its size is not necessarily final yet.
      const selectedRelativePaths = this.filesTrees.toArray()[i].getSelectedFilePathsIncludingExtraInfo().map(x => x.path);

      // No disc this app ever creates - neither an originally-planned one (partitionBackupToOpticalMedia never
      // produces an empty partition) nor an overflow one (maybeAppendOverflowDiscs only ever appends non-empty
      // partitions) - should legitimately have zero files selected here. If it happens anyway - e.g. a
      // freshly-appended overflow disc sent before its own tree has finished being seeded - burning it would
      // silently produce a useless, empty .ibb and leave its real partial file undeleted forever (confirmDiscBurned
      // only deletes what sentDiscPartPaths recorded, which would also be empty). Fail loudly and let the user
      // retry instead - by the time they click again, whatever timing issue caused this has almost certainly
      // resolved.
      if (selectedRelativePaths.length === 0) {
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `Disc ${i + 1} has no files selected to send - this should never happen. Please try clicking "Send to ImgBurn" again.`;
        errorDialog.componentInstance.actionsNum = 1;
        errorDialog.componentInstance.action1Label = "Ok";
        errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); };
        return;
      }

      // Creates this disc's real large-file split partials (if any), lazily, right now - this is the ONLY
      // point a large file actually gets physically split, rather than the whole job's large files all being
      // split up front before any disc is burned. The response can contain MORE entries than were requested (a
      // rare, known boundary case surfaces one extra, unplanned "sliver" partial - see
      // createOpticalMediaDiscPartials's own comment): whichever disc's send action happens to trigger a
      // given large file's real split is offered that file's sliver first, purely as a byproduct of triggering
      // the split - not because it's guaranteed to belong there. Whether it actually ends up on THIS disc is
      // decided below, by the capacity check.
      //
      // Behind its own loading dialog: a real 7-Zip split of a large file can take minutes, and this step used to
      // run with nothing on screen at all. No progress to report (7-Zip gives none), so a plain spinner.
      const splitDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
      splitDialogRef.componentInstance.showCancelButton = false;
      splitDialogRef.componentInstance.message = "Preparing disc files";
      let realStats: filesMetadata[];
      try {
        realStats = (await ipc.createOpticalMediaDiscPartials(this.backup.sourcePath, selectedRelativePaths, this.tempSessionId)).res;
      } catch (error) {
        // E.g. 7-Zip failed, a file was deleted since planning, or a large file changed size since planning (the
        // worker then refuses to split it) - the disc is not sent, and the message says why.
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `Could not prepare the files of disc ${i + 1}: ${error}`;
        errorDialog.componentInstance.actionsNum = 1;
        errorDialog.componentInstance.action1Label = "Ok";
        errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); };
        return;
      } finally {
        splitDialogRef.close();
      }

      // Split the response back into what this disc's tree actually asked for and any surplus sliver(s) riding
      // along with it (see createOpticalMediaDiscPartials's own comment).
      const requestedPaths = new Set(selectedRelativePaths);
      const normalStats = realStats.filter(e => requestedPaths.has(e.path));
      const ownSurplusStats = realStats.filter(e => !requestedPaths.has(e.path));
      let discUsedBytes = normalStats.reduce((sum, e) => sum + e.stats.size, 0);
      const finalStats = normalStats.slice();

      // A surplus partial is accepted onto THIS disc only if the disc's total real, created size still fits
      // within effectiveMediaCapacityInBytes - the SAME margin-discounted capacity partitionBackupToOpticalMedia
      // planned every disc against (see getEffectiveOpticalMediumCapacityInBytes in worker.ts), never the
      // medium's raw capacity: that margin is a general burn-safety feature that applies to everything written
      // to a disc, not something reserved for or spent by surplus slivers specifically.
      //
      // The candidates tried here are this disc's own fresh surplus AND any sliver an EARLIER disc's send
      // already produced but couldn't fit at the time (pendingOverflowPartials) - not just the former. Without
      // this, a sliver rejected by disc 1 would sit untouched until every original disc is sent and then get a
      // brand new, almost entirely empty disc all to itself, even if disc 2 (sent right after, with real
      // content of its own and room to spare) could easily have carried it. Trying the accumulated backlog on
      // every subsequent disc's send - oldest first, so a longer-waiting partial isn't starved by a newer one -
      // means a new disc only ever gets created for whatever still doesn't fit anywhere once every original
      // disc has actually been sent (see maybeAppendOverflowDiscs). This can't eliminate the case entirely: a
      // sliver produced by the LAST original disc sent has no later disc left to offer it to.
      const candidateSurplusPartials = this.pendingOverflowPartials.concat(ownSurplusStats);
      this.pendingOverflowPartials = [];
      for (const surplusPartial of candidateSurplusPartials) {
        if (discUsedBytes + surplusPartial.stats.size <= this.effectiveMediaCapacityInBytes) {
          discUsedBytes += surplusPartial.stats.size;
          finalStats.push(surplusPartial);
        } else {
          this.pendingOverflowPartials.push(surplusPartial);
        }
      }

      // Hashes finalStats in place BEFORE anything below is computed from it - the disc label hash, the
      // metadata JSON entry, and the .ibb file all already see the hash this way, rather than needing a second
      // pass to attach it later.
      //
      // Explicitly caught, like createOpticalMediaDiscPartials just above - a failure
      // here (e.g. a file vanished/got locked in the moment between being created and being hashed) must
      // not silently abort this whole method with nothing shown: without this, the finally block still resets
      // sendingDiscs[i] and re-enables the button, but the user would otherwise see the send simply do nothing.
      try {
        await this.attachSha256HashesToDiscFiles(finalStats);
      } catch (error) {
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `Could not compute SHA-256 hashes for disc ${i + 1}: ${error}`;
        errorDialog.componentInstance.actionsNum = 1;
        errorDialog.componentInstance.action1Label = "Ok";
        errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); };
        return;
      }

      /* We rename the worker's "stats" field to match what used to come from the files-tree's own "extras" -
      same shape, now real/measured instead of an estimate. We also add the volume letter, normalized to
      OPTICAL_DRIVE_LETTER_CONVENTION (see disc-id-hash.ts for why). */
      const selectedFiles = finalStats.map(e => { return { "path": OPTICAL_DRIVE_LETTER_CONVENTION + e.path, "stats": e.stats } });

      // Only the disc's number: during a recovery the app recognizes each inserted disc by itself (a hash of its
      // contents, see getDiscIdHash) and asks for discs by this number.
      await new Promise<void>((resolve) => {
        const labelDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
        labelDialog.disableClose = true;
        labelDialog.componentInstance.title = "Disc label";
        labelDialog.componentInstance.message =
          `Please physically label this disc as disc ${i + 1}. During a future recovery, the app asks for each ` +
          `disc by this number.`;
        labelDialog.componentInstance.actionsNum = 1;
        labelDialog.componentInstance.action1Label = "Ok";
        labelDialog.componentInstance.action1Callback = () => {
          labelDialog.close();
          resolve();
        }
      });

      const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
      loadingDialogRef.componentInstance.message = "Preparing ImgBurn project";
      // Recorded in the metadata JSON only once the disc is confirmed burned - see recordConfirmedDiscs.
      this.discMetadataEntries[i] = selectedFiles;

      // What this disc needed created in the temp folder - split partials, and links' shortcuts (linkTarget) - deleted
      // again once the disc is confirmed burned (confirmDiscBurned).
      this.sentDiscPartPaths[i] = finalStats.filter(e => PART_FILE_PATTERN.test(e.path) || e.stats.linkTarget !== undefined).map(e => e.path);

      // Awaited (previously fired-and-forgotten): see sendingDiscs's own doc comment for why this guard needs
      // this chain's real completion, not just its start, to reset on.
      await this.createIBB_file(i, finalStats.map(e => e.path), this.backup.sourcePath).then(async ()=>{
        this.sentDiscs[i] = true;
        loadingDialogRef.close();
        // Now that this disc has actually been sent, check whether every originally-planned disc has (so no
        // further surplus slivers can still turn up) and, if pendingOverflowPartials is non-empty, append however
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
   *  up - see the capacity check in sendToImgBurn), packs any pendingOverflowPartials onto one or more freshly
   *  appended discs so the user still gets to burn them, using a plain sequential-fill packer (these are at
   *  most a handful of tiny sliver partials - the sophistication of partitionBackupToOpticalMedia's own
   *  First-Fit-Decreasing packer buys nothing here). By the time this runs, most slivers have usually already
   *  been absorbed into a later original disc's own send (see the candidateSurplusPartials handling in
   *  sendToImgBurn) - this is the last resort for whatever is still left over once there is no later original
   *  disc left to offer it to. Each new disc goes through the exact same
   *  select-files/"Send to ImgBurn"/"Confirm disc burned" lifecycle as any other - the partials are already real,
   *  created files by this point, so selecting and sending one merely re-discovers it as "already
   *  created" (see createOpticalMediaDiscPartials), it is never split again.
   *
   *  This does mean the user can end up burning more discs than the number they were originally told they'd
   *  need up front - an acceptable outcome of an already very rare case, but the user is told about it (see
   *  the info dialog below) before the stepper grows, rather than just finding an extra step has appeared.
   *
   *  Safe to call after every disc send; it only does anything the first time both conditions are true, since
   *  draining pendingOverflowPartials here is what stops it from doing anything again for the same partials. */
  private async maybeAppendOverflowDiscs(): Promise<void> {
    const everyOriginalDiscSent = this.sentDiscs.slice(0, this.originalNumberOfDisksNeeded).every(sent => sent);
    if (!everyOriginalDiscSent || this.pendingOverflowPartials.length === 0) {
      return;
    }

    const overflowPartitions: filesMetadata[][] = [];
    let currentPartition: filesMetadata[] = [];
    let currentPartitionBytes = 0;
    for (const partial of this.pendingOverflowPartials) {
      if (currentPartition.length > 0 && currentPartitionBytes + partial.stats.size > this.effectiveMediaCapacityInBytes) {
        overflowPartitions.push(currentPartition);
        currentPartition = [];
        currentPartitionBytes = 0;
      }
      currentPartition.push(partial);
      currentPartitionBytes += partial.stats.size;
    }
    if (currentPartition.length > 0) {
      overflowPartitions.push(currentPartition);
    }
    this.pendingOverflowPartials = [];

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
      this.discMetadataEntries.push(undefined);
      this.recordedDiscs.push(false);
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

  /** Marks disc i as confirmed-burned: deletes its real created split partials (if any) from the temp
   *  directory, marks it confirmed (the template grays out and disables its controls once confirmedDiscs[i]
   *  is true - see the template), then records it in the cold storage metadata JSON (see recordConfirmedDiscs). Discs can be sent/confirmed in any order, independent of each other - there is
   *  no sequencing requirement, matching the already non-linear stepper "Send to ImgBurn" itself allows. */
  async confirmDiscBurned(i: number): Promise<void> {
    if (!this.sentDiscs[i] || this.confirmedDiscs[i]) { return; }
    const partRelativePaths = this.sentDiscPartPaths[i] || [];
    if (partRelativePaths.length > 0) {
      // This job's own session subfolder (see tempSessionId's own doc comment) - the same one create
      // actually wrote these real partials under, not the temp directory's bare root.
      const rawTempDataDirectoryPath: string = (await ipc.getTempDataDirectoryPath()).res;
      const tempDirNormalized = rawTempDataDirectoryPath.replace(/\\$/, '') + '\\' + this.tempSessionId;
      const partialPaths = partRelativePaths.map(p => tempDirNormalized + '\\' + p);
      const response = await ipc.deletePartialsForDisc(partialPaths);
      const result: { cleared: boolean; message: string; deletedItems: string[]; notClearedItems: string[] } = response.res;
      if (!result.cleared) {
        const warnDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '700px' });
        warnDialog.componentInstance.title = "Temp cleanup incomplete";
        warnDialog.componentInstance.message = `Disc ${i + 1} was confirmed burned, but its temporary split-part files could not all be removed: ${result.message} You can safely ignore this - the app offers to clear leftover temp files the next time it starts.`;
        if (result.notClearedItems?.length) {
          warnDialog.componentInstance.lists = [{ label: `Not removed (${result.notClearedItems.length}):`, items: result.notClearedItems }];
        }
        warnDialog.componentInstance.actionsNum = 1;
        warnDialog.componentInstance.action1Label = "Ok";
        warnDialog.componentInstance.action1Callback = () => { warnDialog.close(); };
      }
    }
    this.confirmedDiscs[i] = true;
    await this.recordConfirmedDiscs(i);
  }

  /** Writes disc i's entry to the cold storage metadata JSON, together with the entries of every disc that holds a
   *  piece of the same split large file (linkedDiscGroup) - but only once all of those discs are confirmed burned and
   *  no piece of their files is still waiting for a disc. A split file can only be put back together from all of its
   *  pieces, and "Add missing files" counts a file as backed up as soon as the JSON has any one of its pieces - so
   *  recording only some of those discs would lose the file for good if the rest were never burned. Until then, tells
   *  the user which discs still have to be burned, and that the ones already burned are not recorded yet. */
  private async recordConfirmedDiscs(i: number): Promise<void> {
    const discPaths = this.backup.opticalMediaPartitioning.map((planned, d) => planned.map(x => x.path).concat(this.sentDiscPartPaths[d] || []));
    const group = linkedDiscGroup(i, discPaths, this.pendingOverflowPartials.map(p => p.path), this.tempSessionId);
    const stillToBurn = group.discs.filter(d => !this.confirmedDiscs[d]);
    if (stillToBurn.length > 0 || group.waitingFiles.length > 0) {
      const burnedNotRecorded = group.discs.filter(d => this.confirmedDiscs[d] && !this.recordedDiscs[d]);
      const noticeDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '700px' });
      noticeDialog.componentInstance.title = stillToBurn.length > 0 ? `Also burn ${discsLabel(stillToBurn.map(d => d + 1))}` : 'Keep the app open';
      noticeDialog.componentInstance.message = linkedDiscsNoticeMessage(burnedNotRecorded.map(d => d + 1), stillToBurn.map(d => d + 1),
        group.discs.map(d => d + 1), group.waitingFiles.length);
      noticeDialog.componentInstance.lists = [{ label: `Split across these discs (${group.splitFiles.length}):`, items: group.splitFiles }];
      noticeDialog.componentInstance.actionsNum = 1;
      noticeDialog.componentInstance.action1Label = "Ok";
      noticeDialog.componentInstance.action1Callback = () => { noticeDialog.close(); };
      return;
    }
    const toRecord = group.discs.filter(d => !this.recordedDiscs[d]);
    try {
      await this.metadataUpdateQueue.enqueue(async () => {
        const metadataJSON: Array<Array<{ path: string; stats: any; }>> = (await ipc.readJSONfromDisk(this.coldStorageMetadataJSONPath)).res;
        for (const d of toRecord) { metadataJSON[d] = this.discMetadataEntries[d] || []; }
        // A disc appended for a sliver can be recorded before the one in front of it: no gaps (null) in the array.
        for (let d = 0; d < metadataJSON.length; d++) { if (!Array.isArray(metadataJSON[d])) { metadataJSON[d] = []; } }
        await ipc.writeJSONtoDisk(this.coldStorageMetadataJSONPath, JSON.stringify(metadataJSON, null, 2));
      });
      toRecord.forEach(d => { this.recordedDiscs[d] = true; });
    } catch (error) {
      const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
      errorDialog.componentInstance.title = "Error";
      errorDialog.componentInstance.message = `Could not record ${discsLabel(toRecord.map(d => d + 1))} in the cold storage ` +
        `metadata JSON, although confirmed burned: ${error}`;
      errorDialog.componentInstance.actionsNum = 2;
      errorDialog.componentInstance.action1Label = "Cancel";
      errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); };
      errorDialog.componentInstance.action2Label = "Try again";
      errorDialog.componentInstance.action2Callback = () => { errorDialog.close(); this.recordConfirmedDiscs(i); };
    }
  }

  goToHomePage(){
    goToMainMenuAndReload(this.router);
  }

}
