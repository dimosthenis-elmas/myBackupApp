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
import { WorkerListener, WorkerResponse } from '../../../app/workers/ipc.interfaces';
import { getDiscIdHash } from '../shared/utils/disc-id-hash';
import { goToMainMenuAndReload } from '../shared/utils/go-to-main-menu';

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
import {MatDividerModule} from '@angular/material/divider';
import { CommonModule } from '@angular/common';
import { MatChip } from '@angular/material/chips';
import { MatChipSet } from '@angular/material/chips';
import { OpticalDiscBackupDataRetriever} from '../optical-disc-backup-data-retriever/optical-disc-backup-data-retriever.component';
import { OpticalDiscBackupDataRetrieverModule } from '../optical-disc-backup-data-retriever/optical-disc-backup-data-retriever.module';
import { filesMetadata } from '../../types/interface';
import { compileSchema, JsonSchema, SchemaNode } from "json-schema-library";
import { ColdStorageMetadata } from '../../../app/workers/ipc.interfaces';
import { SerialQueue } from '../shared/utils/serial-queue';
import { PART_FILE_PATTERN } from '../shared/utils/part-file-pattern';
const mySchema =require('../schemas/filesMetadata.schema.json');

@Component({
  selector: 'add-missing-files-to-optical-media-cold-storage',
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
    MatChipSet,
    OpticalDiscBackupDataRetrieverModule,
    MatDividerModule
  ],
  templateUrl: './add-missing-files-to-optical-media-cold-storage.component.html',
  styleUrl: './add-missing-files-to-optical-media-cold-storage.component.scss'
})
export class AddMissigFilesToOpticalMediaColdStorageComponent implements OnInit, OnDestroy{
  
  private _formBuilder = inject(FormBuilder);

  @ViewChild(FilesTreeComponent)
  private filesTree!: FilesTreeComponent;

  firstFormGroup = this._formBuilder.group({
    firstCtrl: ['', Validators.required],
  });

    optical_media_choices: {value: string, viewValue: string, capacity: number}[] = [
    {value: 'cd', viewValue: 'CD (700 MB)', capacity: 0.7e9},
    {value: 'dvd', viewValue: 'DVD (4.7 GB)', capacity: 4.7e9},
    {value: 'blu-ray-25', viewValue: 'Blu ray (25 GB)', capacity: 25e9},
    {value: 'blu-ray-50', viewValue: 'Blu ray (50 GB)', capacity: 50e9},
    {value: 'blu-ray-100', viewValue: 'Blu ray (100 GB)', capacity: 100e9}
  ];

  /** "File integrity data" toggle offered alongside the collection name at step_3 - recorded into each NEW
   *  disc's cold storage metadata entry (see attachSha256HashesToDiscFiles), independently of whether the EXISTING
   *  discs being added to already carry SHA-256 hashes or not (see afterJSONpathIsGiven for how this is
   *  pre-set to match them, as a convenience, when a JSON with existing entries is loaded). */
  public integrityDataOptions: {value: 'sha256' | 'none', viewValue: string}[] = [
    {value: 'sha256', viewValue: 'SHA-256'},
    {value: 'none', viewValue: 'None'}
  ];
  public selectedIntegrityDataOption: {value: 'sha256' | 'none', viewValue: string} = this.integrityDataOptions[0];

  useExternalMetadata = false;
  externalMetadataJSONpath!:string;
  json_coldStorageFilesMetadata!: ColdStorageMetadata;
  /** True from the moment a JSON file is picked (getJSON) until afterJSONpathIsGiven has actually finished
   *  reading + schema-validating it and (on success) populated json_coldStorageFilesMetadata. externalMetadataJSONpath
   *  is set synchronously, well before that finishes - so step1() used to be able to run while this was still in
   *  flight, see json_coldStorageFilesMetadata as not-yet-set (even though a valid JSON WAS chosen), and silently
   *  fall through to the no-JSON path (step_2, "waiting for optical medium to be inserted") instead of validating
   *  against the JSON as the user actually asked. Bound to the "Next" button's [disabled] in the template, and
   *  checked again in step1() itself as a second guard against anything that might invoke it directly. */
  loadingExternalMetadataJSON = false;
  opticalDiscVolumeLetter!:string;
  selected_optical_medium = this.optical_media_choices[1];
  entireColdStorageMetadata!: ColdStorageMetadata;
  totalNumberOfDisksNeeded!:number;
  // This is used for the for loop in the template. It holds the numbers 1..n_disks
  _disks!: Array<number>
  partitions!:ColdStorageMetadata
  /** Full path (folder + file name), chosen by the user via a save dialog, where the updated cold storage
   * metadata JSON is written. See chooseSaveFile(). */
  coldStorageMetadataJSONPathToSave!: string;
  /** Name of this cold storage collection of discs, provided once by the user in step_3 and burned onto every
   * newly-added disc's UDF volume label as "<name> Disc <N>" (see sendToImgBurn/createIBB_file). Not read back
   * from the existing cold storage metadata - retype the same name used originally to keep new discs'
   * labeling consistent with the rest of the collection. */
  coldStorageCollectionName: string = '';
  /** This job's own temp-dir session subfolder name (see SESSION_FOLDER_NAME_PATTERN's own comment in
   *  worker.ts) - generated once (see partition()) and reused for every worker call this job makes that
   *  touches the temp directory (planning, creating split partials, creating .ibb files), so they all agree
   *  on the exact same isolated subfolder. */
  private tempSessionId!: string;
  /** True from the moment partition() starts (past its initial validation) until it returns or throws - guards
   *  against a double-click on step_3's "Next" (also bound to that button's own [disabled] in the template, so
   *  this is a backstop, not the only thing preventing it) running two overlapping partition() calls, which
   *  could otherwise leave tempSessionId and the eventually-assigned this.partitions out of sync with each other
   *  (whichever call's session id was set last vs. whichever call's result was assigned last, independently,
   *  since each happens on the far side of its own separate await). Public so the template can bind to it. */
  public isPartitioning = false;
  isLinear = false;
  step='step_1';
  odbr_ref!: OpticalDiscBackupDataRetriever;
  allFilesSelected = true;
  masterPathsWithStats!:filesMetadata[];
  workerListener!: WorkerListener;
  /** Whether disc i (0-based within this.partitions, i.e. the NEW discs being added) has been sent to ImgBurn
   *  at least once yet - gates "Confirm disc burned". */
  public sentDiscs: boolean[] = [];
  /** True from the moment sendToImgBurn(i) starts until it's fully done (including the fire-and-forget
   *  createIBB_file chain, now awaited - see sendToImgBurn's own comment) - guards against a double-click on
   *  "Send disk i+1 to ImgBurn" for the SAME disc (also bound to that button's own [disabled] in the template,
   *  so this is a backstop, not the only thing preventing it) running two overlapping sends before the first
   *  one has even written its .ibb file yet, which could otherwise trigger two concurrent real 7-Zip splits of
   *  the same large file into the same destination (createOpticalMediaDiscPartials's own existence check is
   *  not itself a lock). Does not block sending a DIFFERENT disc at the same time - that's fine, each disc's
   *  send is independent. Same mechanism as backup-to-optical-media.component.ts's identical field. Public so
   *  the template can bind to it. */
  public sendingDiscs: boolean[] = [];
  /** Whether the user has confirmed disc i was actually burned - see confirmDiscBurned(). Intentionally pure
   *  in-memory state, never persisted: if the app closes mid-job, the user starts over. That is an explicit
   *  decision (no resume support), not an oversight - please don't "fix" this into a persistence feature. */
  public confirmedDiscs: boolean[] = [];
  /** For each new disc i, the bare-relative (relative to this.backup.targetPath) large-file-split-partial paths
   *  actually created and burned for it - captured once in sendToImgBurn, since it can include a rare
   *  surplus partial (a "sliver" - see createOpticalMediaDiscPartials) never part of this.partitions[i] to begin with, so
   *  it can't be recovered later by re-deriving it from that. confirmDiscBurned reads this to know exactly
   *  which real temp-dir files to delete. */
  private sentDiscPartPaths: string[][] = [];
  /** Serializes sendToImgBurn's read-modify-write of the shared cold storage metadata JSON across discs - see
   *  SerialQueue's own doc comment for why this is needed (the stepper is non-linear and every disc's "Send to
   *  ImgBurn" button is always enabled). */
  private metadataUpdateQueue = new SerialQueue();
  /** How many NEW discs (i.e. this.partitions.length at the time) the initial plan (partitionBackupToOpticalMedia,
   *  called from partition()) actually called for - fixed once partition() runs, even though this.partitions/
   *  _disks can later grow (see pendingOverflowPartials). Needed to tell "every originally-planned new disc has
   *  now been sent" apart from "every new disc there currently is, including ones already appended for
   *  overflow, has been sent" - see maybeAppendOverflowDiscs. Same mechanism as
   *  backup-to-optical-media.component.ts's identical field - see its own comment for the full rationale. */
  private originalNumberOfDisksNeeded!: number;
  /** Real, already-created large-file split partials that didn't fit on the disc whose "Send to ImgBurn"
   *  action produced them - see the capacity check in sendToImgBurn, and pendingOverflowPartials's identical
   *  counterpart in backup-to-optical-media.component.ts for the full rationale (this is the same rare
   *  boundary case, handled the same way, for the "add missing files" flow). */
  private pendingOverflowPartials: filesMetadata[] = [];
  /** The selected medium's raw capacity, discounted by config.json's maxOpticalMediumRepletionRatio - see
   *  getEffectiveOpticalMediumCapacityInBytes in worker.ts. Fetched once in partition() and used as the one
   *  capacity every later fit check (surplus slivers included) compares against, instead of the medium's raw
   *  selected_optical_medium.capacity. */
  private effectiveMediaCapacityInBytes!: number;


  constructor(public router: Router, private route: ActivatedRoute, public dialog: MatDialog, public backup: BackupService, private ngZone: NgZone) { }
  

  @ViewChild(OpticalDiscBackupDataRetriever)  set odbr(v: OpticalDiscBackupDataRetriever) {
    setTimeout(() => {
      this.odbr_ref = v;
    }, 0);
  }
  
  ngOnDestroy(): void {
    
  }

  ngOnInit(): void {
    
  }

  async ngAfterViewInit(): Promise<void> {
    let tempDataDirectoryPath = (await ipc.getTempDataDirectoryPath()).res;
    const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '600px'});
    loadingDialogRef.componentInstance.title = "Info";
    loadingDialogRef.componentInstance.message = `Since you want to burn your cold storage backup to a set of optical discs you may come across files which are too large to fit on any single optical disc. In such a case
    we have to split those large files into multiple parts (chunks of 500 MB), in a subfolder created just for this job under the temp data directory located in ${tempDataDirectoryPath}. Each large file's parts are only physically created when the disc that needs them is actually sent to ImgBurn, and are deleted again automatically once you confirm that disc was burned - so normally you don't need to clean this up yourself. If this job ends before every disc is confirmed (e.g. the app was closed before you got to it), that whole subfolder is harmless to delete by hand, or the app will offer to clear it the next time it starts.`;
  }

  async chooseDirectory (): Promise<string>{
    const dialogConfig = {
      title: 'Directory selection',
      buttonLabel: 'Select this directory',
      properties: ['openDirectory']
    };    
    const res = await window.electronAPI.openDialog('showOpenDialog', dialogConfig);
    return res.filePaths[0];
  }

   async chooseFile (): Promise<string>{
    const dialogConfig = {
      title: 'File selection',
      buttonLabel: 'Select file',
      properties: ['openFile']
    };
    const res = await window.electronAPI.openDialog('showOpenDialog', dialogConfig);

    return res.filePaths[0];
  }

  /** Opens a native "Save As" dialog so the user can choose where (and under what file name) to save the
   * updated cold storage metadata JSON, instead of it always being written to the app's temp data directory.
   * @return the chosen full path, or undefined if the user canceled the dialog. */
  async chooseSaveFile(defaultFileName: string): Promise<string | undefined>{
    const dialogConfig = {
      title: 'Select where to save the updated cold storage metadata JSON',
      buttonLabel: 'Save',
      defaultPath: defaultFileName,
      filters: [{ name: 'JSON files', extensions: ['json'] }]
    };
    const res = await window.electronAPI.openDialog('showSaveDialog', dialogConfig);
    return res.canceled ? undefined : res.filePath;
  }

  /** Default filename (and, when available, directory) to seed the "save updated metadata" dialog with -
   * deliberately DIFFERENT from the original externalMetadataJSONpath (the file loaded via getJSON()), so that
   * just accepting the dialog's default doesn't silently overwrite it. Reusing the same name would be an easy
   * trap: 'coldStorageMetadata.json' is also the exact default name backup-to-optical-media.component.ts uses
   * when first creating this JSON, and Electron's save dialog re-opens in the last folder used by a dialog in
   * this app - which, right after getJSON() ran, is the very folder the original file lives in. So without this,
   * the dialog would often pre-fill to the exact original path, and a user who just clicks "Save" would
   * unknowingly overwrite the file they loaded from - even though they were technically asked. */
  private suggestedUpdatedMetadataSavePath(): string {
    if (!this.externalMetadataJSONpath) {
      return 'coldStorageMetadata.json';
    }
    const lastSep = Math.max(this.externalMetadataJSONpath.lastIndexOf('\\'), this.externalMetadataJSONpath.lastIndexOf('/'));
    const dir = lastSep >= 0 ? this.externalMetadataJSONpath.slice(0, lastSep + 1) : '';
    const nameWithoutExt = (lastSep >= 0 ? this.externalMetadataJSONpath.slice(lastSep + 1) : this.externalMetadataJSONpath).replace(/\.json$/i, '');
    return `${dir}${nameWithoutExt} - updated.json`;
  }

  /** Asks where to save the updated metadata JSON (see chooseSaveFile/suggestedUpdatedMetadataSavePath), then
   * - if the user deliberately picks the exact same path as the original externalMetadataJSONpath anyway - asks
   * for confirmation before letting that overwrite happen, so the original stays intact (e.g. for testing)
   * unless the user really means to replace it. Recurses on "Retry"/"Choose a different location" so the
   * caller only has to handle "got a final path" vs "gave up entirely".
   * @return the confirmed full path, or undefined if the user gave up. */
  private async promptForUpdatedMetadataSavePath(): Promise<string | undefined> {
    const chosenPath = await this.chooseSaveFile(this.suggestedUpdatedMetadataSavePath());
    if (!chosenPath) {
      return new Promise<string | undefined>((resolve) => {
        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = "Save location required";
        infoDialog.componentInstance.message = `You need to choose where to save the updated cold storage metadata JSON file to continue.`;
        infoDialog.componentInstance.actionsNum = 2;
        infoDialog.componentInstance.action1Label = "Retry";
        infoDialog.componentInstance.action2Label = "Cancel";
        infoDialog.componentInstance.action1Callback = () => {
          infoDialog.close();
          resolve(this.promptForUpdatedMetadataSavePath());
        }
        infoDialog.componentInstance.action2Callback = () => {
          infoDialog.close();
          resolve(undefined);
        }
      });
    }

    if (this.externalMetadataJSONpath && chosenPath.toLowerCase() === this.externalMetadataJSONpath.toLowerCase()) {
      return new Promise<string | undefined>((resolve) => {
        const warnDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
        warnDialog.disableClose = true;
        warnDialog.componentInstance.title = "Overwrite original metadata JSON?";
        warnDialog.componentInstance.message = `You picked the same file you originally loaded the existing metadata from (${chosenPath}).
        Saving here will overwrite your original JSON with the updated one, so you won't be able to use the original on its own afterwards (e.g. for testing).`;
        warnDialog.componentInstance.actionsNum = 2;
        warnDialog.componentInstance.action1Label = "Overwrite anyway";
        warnDialog.componentInstance.action2Label = "Choose a different location";
        warnDialog.componentInstance.action1Callback = () => {
          warnDialog.close();
          resolve(chosenPath);
        }
        warnDialog.componentInstance.action2Callback = () => {
          warnDialog.close();
          resolve(this.promptForUpdatedMetadataSavePath());
        }
      });
    }

    return chosenPath;
  }

  getDir():void{
    this.chooseDirectory().then((path)=>{
      if(path != undefined){
        this.backup.targetPath = path;
      }
    });
  }

  async getJSON(){
    const path = await this.chooseFile();
    if(path != undefined){
      this.externalMetadataJSONpath = path;
      this.loadingExternalMetadataJSON = true;
      try{
        await this.afterJSONpathIsGiven();
      } finally {
        this.loadingExternalMetadataJSON = false;
      }
    }
  }

  async afterJSONpathIsGiven(){
    //read JSON file
    let res: any;
    try {
      res = (await ipc.readJSONfromDisk(this.externalMetadataJSONpath)).res;
    } catch (error) {
      // The file itself could not even be read/parsed (missing, unreadable, corrupted, or too large - see
      // readJSONfromDisk's own size guard in worker.ts) - previously this propagated out of getJSON() uncaught
      // (only a `finally` there, no `catch`), so the "Reading and validating..." text just silently vanished
      // with no explanation at all. Handled the same way as the recognized-but-wrong-schema case below.
      this.externalMetadataJSONpath = "";
      this.showJsonSelectionErrorDialog("Error", `Could not read this JSON file: ${error}`);
      return;
    }
    // check type
    const schemaNode = compileSchema(mySchema);
    const jsonIsValid = schemaNode.validate(res);
    if(jsonIsValid){
      this.json_coldStorageFilesMetadata = res;
      console.log(this.json_coldStorageFilesMetadata);
      // Nice-to-have convenience: default the new-discs toggle to match whatever the EXISTING cold storage
      // already does, rather than always defaulting to SHA-256 regardless of what's being added to - the user
      // can still change it before continuing.
      const existingEntriesHaveSha256 = this.json_coldStorageFilesMetadata.some(disc => disc.some(f => !!f.stats.sha256));
      this.selectedIntegrityDataOption = existingEntriesHaveSha256 ? this.integrityDataOptions[0] : this.integrityDataOptions[1];
    }else{
      this.externalMetadataJSONpath = "";
      this.showJsonSelectionErrorDialog("JSON selection", `This JSON is not recognised as a files metadata type.`);
    }
  }

  /** Both of afterJSONpathIsGiven()'s failure paths just need to show one dialog and stop - factored out rather
   *  than throwing to unwind back to getJSON() (which only has a `finally`, not a `catch`, so a thrown error
   *  used to become a silently-swallowed unhandled rejection with no dialog at all for the read/parse failure
   *  case - see afterJSONpathIsGiven's own comment). */
  private showJsonSelectionErrorDialog(title: string, message: string): void {
    const dialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
    dialog.componentInstance.title = title;
    dialog.componentInstance.message = message;
  }


  holdOn = (ms: number = 1000) => {
    return new Promise<void>(resolve =>
      setTimeout(() => {
        resolve();
      }, ms)
    );
  }

  selectAllFiles(selected: boolean){
    // Keep the "Select all" checkbox's own [checked] binding (allFilesSelected) in sync with what this
    // actually did to the tree - see the identical fix/comment on selectAllFiles in
    // optical-disc-backup-data-retriever.component.ts for the full explanation of the bug this closes (the
    // checkbox used to stay visually checked regardless of the real selection state, since nothing ever
    // updated it after its initial `= true` declaration).
    this.allFilesSelected = selected;
    if(selected){
      this.filesTree.selectAllNodes();
    }else{
      this.filesTree.deselectAllNodes();
    }
  }

  private replacePartialFileSplits(coldStoragePaths: filesMetadata[], masterPaths: filesMetadata[]): filesMetadata[] {
    this.opticalDiscVolumeLetter = coldStoragePaths[0].path.split('\\').slice(0)[0];
    let r = coldStoragePaths.map((itm, i) => {
      const re = PART_FILE_PATTERN
      let completeLargeFilePathCandidate = itm.path.replace(this.opticalDiscVolumeLetter, "").replace(re, "");
      if(completeLargeFilePathCandidate === itm.path.replace(this.opticalDiscVolumeLetter, "")){
        return itm;
      }else{
        console.log(masterPaths)
        console.log(completeLargeFilePathCandidate)
        console.log(this.backup.targetPath)
        const largeFile = masterPaths.find((o)=> o.path.replace(this.backup.targetPath, "")==completeLargeFilePathCandidate)
        if(largeFile!== undefined){
          largeFile.path = largeFile.path.replace(this.backup.targetPath, this.opticalDiscVolumeLetter)
          return largeFile;
        }else{
          return itm;
        }
      }
    });

    //Remove duplicates.
    const ids = new Set();
    r = r.filter(({ path }) => !ids.has(path) && ids.add(path));
    return r;
  }

  async step1(): Promise<void>{
    // Second guard on top of the "Next" button's own [disabled]="loadingExternalMetadataJSON" - belt-and-braces
    // against anything else that might invoke step1() while a JSON is still being read/validated (see
    // loadingExternalMetadataJSON's own doc comment for the race this closes).
    if(this.useExternalMetadata && this.loadingExternalMetadataJSON){
      return;
    }
    if(
      !this.backup.targetPath ||
      (this.useExternalMetadata && !this.externalMetadataJSONpath)
    ){
      const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
      loadingDialogRef.componentInstance.title = "Missing fileds";
      loadingDialogRef.componentInstance.message = `You have not filled all of the required fields.`;
    }else{
      if(this.json_coldStorageFilesMetadata){
        this.entireColdStorageMetadata = this.json_coldStorageFilesMetadata;
        this.diff(this.entireColdStorageMetadata.flat(), await this.scanMasterDirectoryWithProgress());
      }else{
        this.step='step_2';
        await this.holdOn(500);
        this.odbr_ref.getCombinedFilePathsFromAllOpticalDiscs().then(async (x)=>{
          this.entireColdStorageMetadata = JSON.parse(JSON.stringify(x.filesMetadata));
          this.diff(x.filesMetadata.flat(), await this.scanMasterDirectoryWithProgress());
        });
      }
    }
  }

  /** Scans the master directory (ipc.getFilePathsWithStats) behind a LoadingDialogComponent that shows the
   *  scan's own live, open-ended "items found so far" count as it comes in (see get-file-paths-with-stats in
   *  worker.ts) - this is the most time-consuming step of this wizard's step_1, and previously ran with
   *  no visible feedback at all (the dialog diff() itself opens only starts AFTER this already-finished scan is
   *  passed into it). There's no known total until the scan finishes, so this is a live count, not a
   *  percentage - see getAllFilePathsWithStats' own SCAN_PROGRESS_REPORT_INTERVAL doc comment in worker.ts. */
  private async scanMasterDirectoryWithProgress(): Promise<filesMetadata[]> {
    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
    loadingDialogRef.componentInstance.showCancelButton = false;
    loadingDialogRef.componentInstance.message = "Scanning master directory";
    const listener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        if (response.key === 'get-file-paths-with-stats' && response.status === 'running') {
          const lines = response.res as string[];
          if (lines.length > 0) { loadingDialogRef.componentInstance.message = lines[lines.length - 1]; }
        }
      });
    });
    try {
      return (await ipc.getFilePathsWithStats(this.backup.targetPath)).res;
    } finally {
      listener.removeListener();
      loadingDialogRef.close();
    }
  }

  async diff(coldStoragePathsWithStats: filesMetadata[], masterPathsWithStats: filesMetadata[]){
    this.step='step_3';
    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
    this.masterPathsWithStats = masterPathsWithStats;
    await this.holdOn(500);
    let coldStoragePathsWithoutPartials = this.replacePartialFileSplits(coldStoragePathsWithStats, JSON.parse(JSON.stringify(masterPathsWithStats)));

    this.opticalDiscVolumeLetter = coldStoragePathsWithoutPartials[0].path.split('\\').slice(0)[0] + '\\';
    if (this.backup.targetPath[this.backup.targetPath.length - 1] != '\\') { this.backup.targetPath += "\\"; }

    // Deep copy because this will mutate the values;
    let masterPathsWithStats_ : filesMetadata[]= JSON.parse(JSON.stringify(this.masterPathsWithStats))
    // Set when a modified/out-of-sync file is found below - used after the .filter() to actually stop diff()
    // from continuing on to build and display a (truncated) missing-files tree, which it previously did
    // regardless, right after telling the user the operation could not proceed and was being cancelled.
    let outOfSync = false;
    let missingFiles = masterPathsWithStats_.filter(file => {
      const b = coldStoragePathsWithoutPartials.find((o)=> o.path==file.path.replace(this.backup.targetPath, this.opticalDiscVolumeLetter));
      if (b == undefined) {
        return true // missing
      } else if ((new Date(file.stats.mtime).getTime() > new Date(b.stats.mtime).getTime()) || (file.stats.size != b.stats.size)) {
        // Wrapped both sides in `new Date(...).getTime()`: file.stats.mtime (from a live ipc.getFilePathsWithStats
        // scan of the master directory) is always a real Date, but b.stats.mtime is only a Date when the cold
        // storage side came from physically re-inserting each disc - when it came from a loaded metadata JSON
        // (readJSONfromDisk -> JSON.parse, which never reconstructs Dates) it is a plain ISO string instead. A
        // bare `Date > string` comparison coerces the Date to its numeric timestamp but leaves the string as a
        // string, then - since they're not both strings - falls back to Number(theString), which is NaN for an
        // ISO date string. Any comparison against NaN is false, so that comparison was ALWAYS false whenever b
        // came from a JSON file - silently disabling the mtime half of this out-of-sync check (only the
        // size-mismatch half still worked) for exactly the "load an existing metadata JSON" path this check
        // exists to protect. new Date(x) parses an ISO string correctly, and passing an existing Date through
        // it is a harmless no-op, so this works for both sources.
        // modified. This would be an problem. Show some kind of warning and cancel the operation.
        // Stop the loop
        outOfSync = true;
        masterPathsWithStats_.splice(0);
        this.step = "step_4";
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `It looks like your cold storage does not meet the specifications. Some already backed-up
        files appear to have been modified in your master directory and your cold storage is now out of sync with these changes.
        This operation cannot proceed and you are advised to re-create your cold storage again. We will now cancel the operation.`;
        errorDialog.afterClosed().subscribe(()=>{
          // Exit to main menu.
          goToMainMenuAndReload(this.router);
        });
      } else {
        return false // backed up
      }
    });

    if (outOfSync) {
      loadingDialogRef.close();
      return;
    }

    if(missingFiles.length == 0){
        // Stop here, same as the outOfSync case above - otherwise this fell through to building and briefly
        // showing an empty step_3 "select files to burn" tree underneath this dialog before the navigate-away
        // actually happened. Named infoDialog (not loadingDialogRef) so it doesn't shadow the outer
        // LoadingDialogComponent reference, which still needs closing on its own right here.
        loadingDialogRef.close();
        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
        infoDialog.componentInstance.title = "Info";
        infoDialog.componentInstance.message = `It looks like your cold storage is already up to date. There are no new files in your 'master'
        that are missing from your cold storage.`;
        infoDialog.afterClosed().subscribe(()=>{
          // Exit to main menu.
          goToMainMenuAndReload(this.router);
        });
        return;
    }

    missingFiles = missingFiles.map((itm, i) => {
      itm.path = itm.path.replace(this.backup.targetPath, "");
      return itm;
    });
    loadingDialogRef.componentInstance.message = "Building files tree";
    // A real percentage while the tree is built (list_to_json + buildFileTree - see FilesTreeComponent.
    // setTreeData's own comment) instead of the plain spinner shown until now - missingFiles.length is already
    // known here, so subscribing before calling setTreeData catches every progress emit, including the first.
    const buildProgressSubscription = this.filesTree.buildProgress.subscribe((percent) => {
      loadingDialogRef.componentInstance.percent = percent;
    });
    try {
      await this.filesTree.setTreeData(missingFiles.map(m => m.path));
    } finally {
      buildProgressSubscription.unsubscribe();
    }
    this.filesTree.selectAllNodes();
    this.filesTree.expandAllNodes();
    loadingDialogRef.close();

  }

  async partition(){
    // Guards against a double-click on step_3's "Next" (see isPartitioning's own doc comment) running two
    // overlapping calls to this method.
    if (this.isPartitioning) { return; }

    if (!this.coldStorageCollectionName.trim()) {
      const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
      infoDialog.disableClose = true;
      infoDialog.componentInstance.title = "Collection name required";
      infoDialog.componentInstance.message = `Please provide a name for this cold storage collection of discs before continuing.`;
      infoDialog.componentInstance.actionsNum = 1;
      infoDialog.componentInstance.action1Label = "Ok";
      infoDialog.componentInstance.action1Callback = () => { infoDialog.close(); }
      return;
    }

    this.isPartitioning = true;
    try {
      // Ask where to save the updated metadata JSON before doing any of the (potentially slow) partitioning
      // work, so a canceled save dialog doesn't waste it. Defaults to a name/location distinct from the original
      // externalMetadataJSONpath, and confirms before letting the user overwrite it anyway - see
      // promptForUpdatedMetadataSavePath - so the original stays available (e.g. for testing) unless they really
      // mean to replace it.
      const chosenPath = await this.promptForUpdatedMetadataSavePath();
      if (!chosenPath) {
        return;
      }
      this.coldStorageMetadataJSONPathToSave = chosenPath;

      let loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
      let selectedPaths = this.filesTree.getSelectedData().map((m)=>{return this.backup.targetPath.concat(m)});

      let selectedPathsWithMetadata: filesMetadata[] = [];
      for (let index = 0; index < selectedPaths.length; index++) {
        let itm = this.masterPathsWithStats.find((o)=> o.path==selectedPaths[index]);
        if(itm!==undefined){
          selectedPathsWithMetadata.push(itm);
        }
      }

      //console.log(selectedPaths);

      //console.log(this.masterPathsWithStats);
      console.log(selectedPathsWithMetadata);

      // Generated once per job (partition() is only ever called once per job - unlike backup-to-optical-
      // media.component.ts's WriteToOpticalMediaProceed, there is no "try without splitting, retry with
      // splitting" chain here to worry about reusing the same id across).
      this.tempSessionId = 'session-' + Date.now();

      // partitionBackupToOpticalMedia now plans using fast size ESTIMATES for any large-file split partials
      // (never invoking 7-Zip here) - the real split, and this.partitions' real sizes, only happen later, lazily,
      // disc by disc, in sendToImgBurn - see its own comment and createOpticalMediaDiscPartials in worker.ts.
      this.partitions =  (await ipc.partitionBackupToOpticalMedia(this.backup.targetPath, this.selected_optical_medium.capacity, true, this.tempSessionId, selectedPathsWithMetadata)).res;
      console.log(this.partitions)

      // Same effective (margin-discounted) capacity partitionBackupToOpticalMedia itself planned against - see
      // getEffectiveOpticalMediumCapacityInBytes in worker.ts. sendToImgBurn/maybeAppendOverflowDiscs must judge
      // whether a surplus sliver fits against this exact number, never the medium's raw capacity: that margin is
      // a general burn-safety feature, not something reserved for or spent by handling surplus slivers.
      this.effectiveMediaCapacityInBytes = (await ipc.getEffectiveOpticalMediumCapacity(this.selected_optical_medium.capacity)).res;
      this.originalNumberOfDisksNeeded = this.partitions.length;

      // Scaffold write: existing discs unchanged, plus one empty placeholder per new disc. Each new disc's real
      // entry is patched in individually, in sendToImgBurn, once its partials are actually created with real
      // (not estimated) sizes - mirrors backup-to-optical-media.component.ts's identical scaffold-then-incremental
      // pattern, rather than writing every new disc's (still-estimated) data in one shot up front, before any of
      // them have actually been burned.
      const scaffold: ColdStorageMetadata = (JSON.parse(JSON.stringify(this.entireColdStorageMetadata)) as ColdStorageMetadata)
        .concat(Array(this.partitions.length).fill([]));
      await ipc.writeJSONtoDisk(this.coldStorageMetadataJSONPathToSave, JSON.stringify(scaffold, null, 2));

      this._disks = [...Array(this.partitions.length).keys()]
      this.sentDiscs = Array(this.partitions.length).fill(false);
      this.sendingDiscs = Array(this.partitions.length).fill(false);
      this.confirmedDiscs = Array(this.partitions.length).fill(false);
      this.sentDiscPartPaths = Array(this.partitions.length).fill(null).map(() => []);
      this.step = "step_5";
      loadingDialogRef.close();

      let loadingDialogRef2 = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '600px'});
      loadingDialogRef2.componentInstance.title = "Cold storage metadata prepared";
      loadingDialogRef2.componentInstance.message = `A scaffold for the updated cold storage metadata (containing placeholders for the new missing files' discs) has been saved to ${this.coldStorageMetadataJSONPathToSave}.
      It will be filled in, one disc at a time, as you send each new disc to ImgBurn below - once every disc has been sent, you may keep this .json file for future updates to your cold storage without having to input all the optical discs one by one again.`;
    } finally {
      this.isPartitioning = false;
    }
  }

  /** Unlike backup-to-optical-media.component.ts (a brand new cold storage, always starting at disc 1), discs
   * added here go onto the END of an already-existing collection - "Disc N" has to account for however many
   * discs already exist, not just disk_id within this session. That existing count is always
   * entireColdStorageMetadata.length: with a JSON, that's trustworthy since json_coldStorageFilesMetadata is
   * schema-validated up front (see seedFromExternalMetadata/step1); without one, entireColdStorageMetadata IS
   * the disc-by-disc reconstruction the user just built by physically inserting every disc
   * (readAllDiscsToReconstructTheCompleteBackupFilePaths) - there's no separate "confirm the real total"
   * number to reconcile against, since the user inserting every disc is what makes that reconstruction
   * trustworthy in the first place (there used to be a second, manually-typed total for this - dropped since
   * it duplicated exactly what entireColdStorageMetadata.length already answers correctly here, and had no way
   * to actually stay in sync with it if the two ever disagreed).
   *
   * This is also exactly the same count partition()'s own metadata-JSON scaffold is built from
   * (JSON.parse(JSON.stringify(this.entireColdStorageMetadata)).concat(...)), so a disc's label here and its
   * actual position in the saved JSON can never disagree with each other - both come from the same value.
   *
   * Computed ONCE here (rather than separately in both sendToImgBurn's on-screen label message and
   * createIBB_file's actual burned volume label, as it used to be) so the two can never drift apart again -
   * found for real (2026-08-27) via ui/test-add-missing-files.js: sendToImgBurn's "please label this disc as
   * disc N" message was using the bare local disk_id (always starting back at 1), while createIBB_file's real
   * burned volume label correctly continued the numbering - so a user adding to an existing 1-disc collection
   * would have been told to label their new disc "1" when its actual embedded label said "Disc 2", risking a
   * real mislabeled disc (this app's own recovery flow depends on discs being labeled to match their JSON order
   * - see the root README). */
  private getNextDiscNumber(disk_id: number): number {
    return this.entireColdStorageMetadata.length + disk_id + 1;
  }

  /** If the "File integrity data" option is set to SHA-256, computes and attaches a `sha256` hash to every
   *  non-directory entry of `finalStats` (mutated in place) - see computeSha256ForBackedUpFiles in worker.ts
   *  and its identical counterpart in backup-to-optical-media.component.ts. Must be called after
   *  createOpticalMediaDiscPartials has already produced this disc's real, final file list (every entry
   *  must already exist on disk, under this.backup.targetPath here rather than a "source" path), and before
   *  anything else about this disc (its label hash, its metadata JSON entry, its .ibb file) is computed from
   *  that list. A no-op when the option is "None", or when finalStats has no non-directory entries. */
  private async attachSha256HashesToDiscFiles(finalStats: filesMetadata[]): Promise<void> {
    if (this.selectedIntegrityDataOption.value !== 'sha256') { return; }
    const hashableEntries = finalStats.filter(e => !e.stats.isDirectory);
    if (hashableEntries.length === 0) { return; }

    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
    loadingDialogRef.componentInstance.showCancelButton = false;
    loadingDialogRef.componentInstance.message = "Calculating SHA-256 hashes";
    loadingDialogRef.componentInstance.lines = [];
    loadingDialogRef.componentInstance.total = hashableEntries.length;
    const listener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        if (response.key === 'compute-sha256-for-backed-up-files' && response.status === 'running') {
          loadingDialogRef.componentInstance.pushLines(response.res as string[]);
        }
      });
    });
    try {
      const hashResults: Array<{ path: string, sha256: string }> =
        (await ipc.computeSha256ForBackedUpFiles(this.backup.targetPath, hashableEntries.map(e => e.path), this.tempSessionId)).res;
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

  async sendToImgBurn(i: number){
    // Guards against a double-click on "Send disk i+1 to ImgBurn" for this SAME disc (see sendingDiscs's own
    // doc comment) - not against sending a different disc at the same time, which is independent and fine. The
    // whole method body is wrapped so the guard covers the once-fired-and-forgotten createIBB_file chain too
    // (now awaited below) - resetting the flag before that had actually finished would reopen the exact narrow
    // window (no .ibb written yet) this guard exists to close.
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

      let volumeFilePathsWithMetadata: Array<filesMetadata> = JSON.parse(JSON.stringify(this.partitions[i]))
      // Trailing backslash ensured - see the identical fix/comment on tempPath in partition() above for why.
      let tempDataDirectoryPath = (await ipc.getTempDataDirectoryPath()).res;
      if (tempDataDirectoryPath[tempDataDirectoryPath.length - 1] != '\\') { tempDataDirectoryPath += '\\'; }
      // This job's own session subfolder (see tempSessionId's own doc comment) - partitionBackupToOpticalMedia's
      // predicted split-partial paths already have this baked into their absolute path, so it must be trimmed off
      // here too, or it would leak into bareRelativePaths below (which must stay session-agnostic - see
      // SESSION_FOLDER_NAME_PATTERN's own comment in worker.ts for why that matters).
      tempDataDirectoryPath += this.tempSessionId + '\\';
      const nextDiscNumber = this.getNextDiscNumber(i);

      /* the response from the worker returns the full paths relative to the host file system.
        Since we are indifferent for the full system file structure we trim the 'this.backup.sourcePath'
        part from all paths. This way our root becomes the directory chosen by the user in the dialog.
        In case there are large files which have been splitted, the splits are stored in the temp data
        directory which is different from the source directory (this.backup.targetPath), so both prefixes are
        trimmed - the same "either/or" idiom this component already used before this disc's partials could be
        created lazily. */
      const bareRelativePaths: string[] = volumeFilePathsWithMetadata.map((a: filesMetadata) =>
        a.path.replace(this.backup.targetPath, "").replace(tempDataDirectoryPath, ""));

      // No disc this wizard ever creates - neither an originally-planned one (partitionBackupToOpticalMedia never
      // produces an empty partition) nor an overflow one (maybeAppendOverflowDiscs only ever appends non-empty
      // partitions) - should legitimately have zero files here. Burning it anyway would silently produce a
      // useless, empty .ibb and leave its real partial file undeleted forever (confirmDiscBurned only deletes what
      // sentDiscPartPaths recorded, which would also be empty). Fail loudly and let the user retry instead.
      if (bareRelativePaths.length === 0) {
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `Disc ${i + 1} has no files to send - this should never happen. Please try clicking "Send to ImgBurn" again.`;
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
      const realStats: filesMetadata[] = (await ipc.createOpticalMediaDiscPartials(this.backup.targetPath, bareRelativePaths, this.tempSessionId)).res;

      // Split the response back into what this disc was actually planned to hold and any surplus sliver(s)
      // riding along with it (see createOpticalMediaDiscPartials's own comment).
      const requestedPaths = new Set(bareRelativePaths);
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
      // this, a sliver rejected by disc 1 would sit untouched until every original new disc is sent and then
      // get a brand new, almost entirely empty disc all to itself, even if disc 2 (sent right after, with real
      // content of its own and room to spare) could easily have carried it. Trying the accumulated backlog on
      // every subsequent disc's send - oldest first, so a longer-waiting partial isn't starved by a newer one -
      // means a new disc only ever gets created for whatever still doesn't fit anywhere once every originally-
      // planned new disc has actually been sent (see maybeAppendOverflowDiscs). This can't eliminate the case
      // entirely: a sliver produced by the LAST originally-planned disc sent has no later disc left to offer it to.
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

      // Hashes finalStats in place (if the "File integrity data" option is SHA-256) BEFORE anything below is
      // computed from it - the disc label hash, the metadata JSON entry, and the .ibb file all already see the
      // hash this way, rather than needing a second pass to attach it later.
      //
      // Explicitly caught (unlike createOpticalMediaDiscPartials just above, which still isn't) - a failure
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

      // Same disc-identification hash used during recovery (see getDiscIdHash / OpticalDiscBackupDataRetriever) -
      // computed from the exact same normalization used when writing this disc's entry into the cold storage
      // metadata JSON below (this.opticalDiscVolumeLetter), so the label the user writes on the physical disc now
      // will match what the app later checks against when that disc is inserted for a recovery.
      const discIdHash = getDiscIdHash(
        finalStats.map((e) => this.opticalDiscVolumeLetter + e.path).sort().toString()
      );

      await new Promise<void>((resolve) => {
        const labelDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
        labelDialog.disableClose = true;
        labelDialog.componentInstance.title = "Disc label";
        labelDialog.componentInstance.message =
          `Please physically label this disc as disc ${nextDiscNumber}, with ID hash: ${discIdHash}. Both are ` +
          `needed to identify this disc correctly during a future recovery.`;
        labelDialog.componentInstance.actionsNum = 1;
        labelDialog.componentInstance.action1Label = "Ok";
        labelDialog.componentInstance.action1Callback = () => {
          labelDialog.close();
          resolve();
        }
      });

      const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });

      // Enqueue this disc's read-modify-write onto the shared serial queue (see metadataUpdateQueue's own doc
      // comment) and await its own turn specifically - not just whatever else is queued - so a later disc's
      // call, enqueued after this one, can never run its own read until this write has actually finished. The
      // scaffold written in partition() reserved index (existing disc count + i) for this exact disc.
      //
      // Unlike backup-to-optical-media.component.ts's equivalent (which only logs and continues), a failure here
      // stops and surfaces a real error instead of silently proceeding to createIBB_file: this JSON is the
      // permanent record recovery depends on, so burning a disc whose data never actually made it into that
      // record would be a real, silent loss - worse than the merely-annoying stuck spinner this also prevents.
      try {
        await this.metadataUpdateQueue.enqueue(async () => {
          const updatedMetadataJSON: ColdStorageMetadata = (await ipc.readJSONfromDisk(this.coldStorageMetadataJSONPathToSave)).res;
          updatedMetadataJSON[this.entireColdStorageMetadata.length + i] = finalStats.map((e) => {
            return { path: this.opticalDiscVolumeLetter + e.path, stats: e.stats };
          });
          await ipc.writeJSONtoDisk(this.coldStorageMetadataJSONPathToSave, JSON.stringify(updatedMetadataJSON, null, 2));
        });
      } catch (error) {
        loadingDialogRef.close();
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `Failed to update the cold storage metadata JSON for this disc - it was NOT sent to ImgBurn, so nothing was burned without being recorded in the JSON. Error: ${error}`;
        return;
      }

      this.sentDiscPartPaths[i] = finalStats.filter(e => PART_FILE_PATTERN.test(e.path)).map(e => e.path);

      // Awaited (previously fired-and-forgotten): see sendingDiscs's own doc comment for why this guard needs
      // this chain's real completion, not just its start, to reset on.
      await this.createIBB_file(i, finalStats.map(e => e.path), this.backup.targetPath, nextDiscNumber).then(async ()=>{
        this.sentDiscs[i] = true;
        loadingDialogRef.close();
        // Now that this disc has actually been sent, check whether every originally-planned new disc has (so no
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

  /** Once every originally-planned new disc has been sent to ImgBurn (so no more surplus slivers can still
   *  turn up - see the capacity check in sendToImgBurn), packs any pendingOverflowPartials onto one or more
   *  freshly appended new discs so the user still gets to burn them, using a plain sequential-fill packer
   *  (these are at most a handful of tiny sliver partials - the sophistication of
   *  partitionBackupToOpticalMedia's own First-Fit-Decreasing packer buys nothing here). By the time this
   *  runs, most slivers have usually already been absorbed into a later original disc's own send (see the
   *  candidateSurplusPartials handling in sendToImgBurn) - this is the last resort for whatever is still left
   *  over once there is no later original disc left to offer it to. Each new disc goes
   *  through the exact same "Send to ImgBurn"/"Confirm disc burned" lifecycle as any other - the partials are
   *  already real, created files by this point, so sending one merely re-discovers them as "already
   *  created" (see createOpticalMediaDiscPartials), never split again. Unlike a brand new
   *  backup-to-optical-media disc, there's no per-disc files-tree to populate here (see partition()/the step_5
   *  template - each disc's content is just whatever this.partitions[disk] holds), so appending a partition is
   *  all that's needed for the stepper to pick it up.
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

    const previousTotal = this.partitions.length;
    const newTotal = previousTotal + overflowPartitions.length;

    // Tell the user before the stepper grows underneath them, not after - a new step silently appearing in the
    // list would be a far more confusing way to find out the estimate changed than being told upfront why it
    // did. Only "Ok" is offered (nothing to decide here - the extra disc(s) need burning regardless).
    await new Promise<void>((resolve) => {
      const infoDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
      infoDialog.disableClose = true;
      infoDialog.componentInstance.title = "Disc count updated";
      infoDialog.componentInstance.message =
        `The estimated number of new discs needed has changed: it was ${previousTotal}, but a rare ` +
        `file-splitting edge case means ${overflowPartitions.length} more disc(s) are needed to fit ` +
        `everything. You will now need ${newTotal} new discs in total.`;
      infoDialog.componentInstance.actionsNum = 1;
      infoDialog.componentInstance.action1Label = "Ok";
      infoDialog.componentInstance.action1Callback = () => {
        infoDialog.close();
        resolve();
      }
    });

    for (const partition of overflowPartitions) {
      this.partitions.push(partition);
      this.sentDiscs.push(false);
      this.sendingDiscs.push(false);
      this.confirmedDiscs.push(false);
      this.sentDiscPartPaths.push([]);
    }
    this._disks = [...Array(newTotal).keys()];
  }

  /** Marks disc i (0-based within this.partitions, i.e. among the NEW discs being added) as confirmed-burned:
   *  deletes its real created split partials (if any) from the temp directory, then marks it confirmed (the
   *  template grays out and disables its controls once confirmedDiscs[i] is true). Discs can be sent/confirmed
   *  in any order, independent of each other - matching the already non-linear stepper "Send to ImgBurn" itself
   *  allows. */
  async confirmDiscBurned(i: number): Promise<void> {
    if (!this.sentDiscs[i] || this.confirmedDiscs[i]) { return; }
    const partRelativePaths = this.sentDiscPartPaths[i] || [];
    if (partRelativePaths.length > 0) {
      // This job's own session subfolder (see tempSessionId's own doc comment) - the same one create
      // actually wrote these real partials under, not the temp directory's bare root.
      const rawTempDataDirectoryPath: string = (await ipc.getTempDataDirectoryPath()).res;
      const tempDirNormalized = rawTempDataDirectoryPath.replace(/\\$/, '') + '\\' + this.tempSessionId;
      const partialPaths = partRelativePaths.map(p => tempDirNormalized + '\\' + p);
      await ipc.deletePartialsForDisc(partialPaths);
    }
    this.confirmedDiscs[i] = true;
  }

    /*
  This creates an ImgBurn project. This will be used to send the files to ImbBurn.
  As for 'paths: Array<string>': An array of the paths to be written to the specific disk. Note that the paths are note full system paths,
  (for example C:\**\*\my_backup_dir\**\*\some_file). Rather they are of the form: my_backup_dir\**\*\some_file.
  This C:\**\*\ part of the path is given in sourcePath. nextDiscNumber is computed once by the caller (see
  getNextDiscNumber's own doc comment for why it's no longer recomputed here separately).
  */
  async createIBB_file (disk_id:number, paths: Array<string>, sourcePath: string, nextDiscNumber: number){
    const collectionName = this.coldStorageCollectionName.trim();
    const volumeLabel = (collectionName ? collectionName + ' ' : '') + 'Disc ' + nextDiscNumber;

    this.workerListener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        switch (response.key) {
          case 'create-IBB-file':
            if(response.status == 'completed'){
              console.log(response)
            }
            break;
          case 'imgburn-launch-failed': {
            // Pushed independently by invokeImgBurnOnIBBFile (worker.ts), asynchronously - by the time ImgBurn
            // actually fails to launch, createIBB_file/openExistingIBBFile have already resolved successfully
            // (see that function's own doc comment), so this can arrive well after either of those calls
            // returned, not as part of their own response. Nothing about the sent/created/metadata-JSON
            // state for this disc is trustworthy once ImgBurn itself never actually opened, so send the user
            // back to the main menu rather than leaving them on a screen that looks like the send succeeded.
            const failureDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
            failureDialog.componentInstance.title = "Error";
            failureDialog.componentInstance.message = `ImgBurn could not be launched: ${response.res.message}`;
            failureDialog.componentInstance.actionsNum = 1;
            failureDialog.componentInstance.action1Label = "Ok";
            failureDialog.componentInstance.action1Callback = () => {
              failureDialog.close();
              goToMainMenuAndReload(this.router);
            };
            break;
          }
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


}
