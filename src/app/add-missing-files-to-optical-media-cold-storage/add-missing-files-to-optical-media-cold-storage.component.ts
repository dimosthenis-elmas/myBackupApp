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
    {value: 'blu-ray', viewValue: 'Blu ray (25 GB)', capacity: 25e9},
    {value: 'blu-ray', viewValue: 'Blu ray (50 GB)', capacity: 50e9},
    {value: 'blu-ray', viewValue: 'Blu ray (100 GB)', capacity: 100e9}
  ];

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
  /** Total number of discs already in the existing cold storage, as confirmed by the user themselves - only
   * asked for (and only used) when useExternalMetadata is false. Without a JSON, the number of discs the user
   * physically inserted while rebuilding entireColdStorageMetadata (readAllDiscsToReconstructTheComplete-
   * BackupFilePaths) cannot be trusted as the true total: the user can click "All disks have been processed"
   * after any number of discs, with nothing to check that count against. Asking for the real total directly
   * lets new discs still be numbered correctly ("Disc N") in this path too - see createIBB_file. */
  existingColdStorageDiscCount: number | null = null;
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
  isLinear = false;
  step='step_1';
  odbr_ref!: OpticalDiscBackupDataRetriever;
  allFilesSelected = true;
  masterPathsWithStats!:filesMetadata[];
  workerListener!: WorkerListener;


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
    loadingDialogRef.componentInstance.title = "Warning";
    loadingDialogRef.componentInstance.message = `This app is a work in progress. This means that we have taken some shortcuts and some restrictions apply.
    Since you want to burn your cold storage backup to a set of optical discs you may come accross files which are too large to fit to any single optical disc. In such a case
    we have to split the large file to multiple parts (we split in chunks of 500 MB). Once restriction of this version of the app is the need to store the partial files
    to disk before burning them to the optical media. Now, you may suspect that we should have been able to create some sort of virtual 'view' of the original large files
    instead of spliting them and storing the parts to disk (e.g. hdd) (thus duplicating the same data since we are not using compression). And you are right we could
    have imlemented something like that but because such an implementation is somehow complicated we are leaving this feature for a future version of the app.
    In conclusion you may want to delete the directory ${tempDataDirectoryPath} which stores all those partial files, after you have finished burning your optical media
    in order to save space for your disk (e.g. hdd). Thank you for your understanding!`;
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
    let res = (await ipc.readJSONfromDisk(this.externalMetadataJSONpath)).res;
    // check type
    const schemaNode = compileSchema(mySchema);
    const jsonIsValid = schemaNode.validate(res);
    if(jsonIsValid){
      this.json_coldStorageFilesMetadata = res;
      console.log(this.json_coldStorageFilesMetadata);  
    }else{
      const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
      loadingDialogRef.componentInstance.title = "JSON selection";
      loadingDialogRef.componentInstance.message = `This JSON is not recognised as a files metadata type.`;
      this.externalMetadataJSONpath = "";
      throw("This JSON is not recognised as a files metadata type.");
      
    }  
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
      // Escaped dots and case-insensitive, matching the canonical PART_FILE_PATTERN in worker.ts exactly (this
      // is a separate, local reimplementation of the same ".part.NNN" convention, not an import of that one -
      // worker.ts is Node-side code with its own require()s and is not meant to be pulled into the renderer
      // bundle). The previous /.part.\d+$/ left both dots unescaped, so they matched ANY character rather than
      // a literal ".", and had no /i flag - looser and case-sensitive compared to the pattern it was meant to
      // mirror.
      const re = /\.part\.\d+$/i
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
      (this.useExternalMetadata && !this.externalMetadataJSONpath) ||
      (!this.useExternalMetadata && !(this.existingColdStorageDiscCount && this.existingColdStorageDiscCount >= 1))
    ){
      const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
      loadingDialogRef.componentInstance.title = "Missing fileds";
      loadingDialogRef.componentInstance.message = `You have not filled all of the required fields.`;
    }else{
      if(this.json_coldStorageFilesMetadata){
        this.entireColdStorageMetadata = this.json_coldStorageFilesMetadata;
        this.diff(this.entireColdStorageMetadata.flat(), (await ipc.getFilePathsWithStats(this.backup.targetPath)).res);
      }else{
        this.step='step_2';
        await this.holdOn(500);
        this.odbr_ref.getCombinedFilePathsFromAllOpticalDiscs().then(async (x)=>{
          this.entireColdStorageMetadata = JSON.parse(JSON.stringify(x.filesMetadata));
          this.diff(x.filesMetadata.flat(), (await ipc.getFilePathsWithStats(this.backup.targetPath)).res);
        });
      }
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
          this.router.navigate(['main-menu'])
            .then(() => {
            window.location.reload();
          });
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
        const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
        loadingDialogRef.componentInstance.title = "Info";
        loadingDialogRef.componentInstance.message = `It looks like your cold storage is already up to date. There are no new files in your 'master'
        that are missing from your cold storage.`;
        loadingDialogRef.afterClosed().subscribe(()=>{
          // Exit to main menu.
          this.router.navigate(['main-menu'])
            .then(() => {
            window.location.reload();
          });
        });
    }

    missingFiles = missingFiles.map((itm, i) => {
      itm.path = itm.path.replace(this.backup.targetPath, "");
      return itm;
    });
    await this.filesTree.setTreeData(missingFiles.map(m => m.path));
    this.filesTree.selectAllNodes();
    this.filesTree.expandAllNodes();
    loadingDialogRef.close();

  }

  async partition(){
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

    // tempPath is still needed below to strip the temp data directory prefix from any large-file splits -
    // it is no longer where the metadata JSON itself gets saved (see coldStorageMetadataJSONPathToSave above).
    // Trailing backslash ensured the same way this.backup.targetPath already is (see diff()) - without it, a
    // split piece's real path (e.g. "...\tempFilesCanBeDeleted\large-files\file.bin.part.001") loses only the
    // directory NAME when the prefix is stripped, leaving a stray LEADING backslash behind
    // ("\large-files\file.bin.part.001") - which corrupts both this JSON entry's path (an extra "D:\\" doubled
    // separator) and, via the identical bug in sendToImgBurn() below, the real .ibb file's own directory
    // structure (an empty-named root directory entry, plus a doubled-backslash "large-files" entry) - found for
    // real (2026-08-27) via ui/test-add-missing-files.js's real .ibb/JSON output.
    let tempPath = (await ipc.getTempDataDirectoryPath()).res;
    if (tempPath[tempPath.length - 1] != '\\') { tempPath += '\\'; }

    this.partitions =  (await ipc.partitionBackupToOpticalMedia(this.backup.targetPath, this.selected_optical_medium.capacity, true, selectedPathsWithMetadata)).res;
    console.log(this.partitions)
    await ipc.writeJSONtoDisk(this.coldStorageMetadataJSONPathToSave, JSON.stringify(
      (JSON.parse(JSON.stringify(this.entireColdStorageMetadata)))
      .concat(JSON.parse(JSON.stringify(this.partitions)))
      .map((x: filesMetadata[]) => {console.log(x); return x.map((a: filesMetadata)=>{
      console.log(a)
      a.path = a.path.replace(this.backup.targetPath, this.opticalDiscVolumeLetter)
      a.path = a.path.replace(tempPath, this.opticalDiscVolumeLetter)
      return a
      })})
      , null, 2));


    this._disks = [...Array(this.partitions.length).keys()]
    this.step = "step_5";
    loadingDialogRef.close();

    let loadingDialogRef2 = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '600px'});
    loadingDialogRef2.componentInstance.title = "Cold storage metadata saved to JSON";
    loadingDialogRef2.componentInstance.message = `The updated metadata (containing the new missing files) for your entire cold storage has been saved to ${this.coldStorageMetadataJSONPathToSave}.
    You may keep this .json file for future updates to your cold storage without having to input all the optical discs one by one again.`;

  }

  /** Unlike backup-to-optical-media.component.ts (a brand new cold storage, always starting at disc 1), discs
   * added here go onto the END of an already-existing collection - "Disc N" has to account for however many
   * discs already exist, not just disk_id within this session.
   *
   * With a JSON, that existing count is entireColdStorageMetadata.length - trustworthy since
   * json_coldStorageFilesMetadata is schema-validated up front (see seedFromExternalMetadata/step1), so it's
   * guaranteed to be the JSON's actual full, correct disc count.
   *
   * Without a JSON, entireColdStorageMetadata is instead built by having the user manually insert discs one at a
   * time (readAllDiscsToReconstructTheCompleteBackupFilePaths) - nothing enforces that they inserted every single
   * one before proceeding (they can click "All disks have been processed" after any number of discs), so
   * entireColdStorageMetadata.length there cannot be trusted as the real total. Instead,
   * existingColdStorageDiscCount - the total the user was directly asked to confirm in step_1 specifically
   * because of this - is used for the same offset.
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
    const existingDiscCount = this.json_coldStorageFilesMetadata
      ? this.entireColdStorageMetadata.length
      : (this.existingColdStorageDiscCount || 0);
    return existingDiscCount + disk_id + 1;
  }

  async sendToImgBurn(i: number){
    let volumeFilePathsWithMetadata: Array<filesMetadata> = JSON.parse(JSON.stringify(this.partitions[i]))
    // Trailing backslash ensured - see the identical fix/comment on tempPath in partition() above for why.
    let tempDataDirectoryPath = (await ipc.getTempDataDirectoryPath()).res;
    if (tempDataDirectoryPath[tempDataDirectoryPath.length - 1] != '\\') { tempDataDirectoryPath += '\\'; }
    const nextDiscNumber = this.getNextDiscNumber(i);

    // Same disc-identification hash used during recovery (see getDiscIdHash / OpticalDiscBackupDataRetriever) -
    // computed from the exact same normalization partition() uses when writing this disc's entry into the cold
    // storage metadata JSON (this.backup.targetPath / the temp data directory prefix replaced by
    // this.opticalDiscVolumeLetter), so the label the user writes on the physical disc now will match what the
    // app later checks against when that disc is inserted for a recovery.
    const discIdHash = getDiscIdHash(
      volumeFilePathsWithMetadata.map((a: filesMetadata) => {
        return a.path.replace(this.backup.targetPath, this.opticalDiscVolumeLetter).replace(tempDataDirectoryPath, this.opticalDiscVolumeLetter);
      }).sort().toString()
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

    /* the response from the worker returns the full paths relative to the host file system.
      Since we are indifferent for the full system file structure we trim the 'this.backup.sourcePath'
      part from all paths. This way our root becomes the directory chosen by the user in the dialog.*/
    let paths: string[] = volumeFilePathsWithMetadata.map(
      (a: filesMetadata)=>{
        return a.path.replace(this.backup.targetPath,  "");
    });

    /*In case there are large files which have been splitted, the splits are stored in the temp data directory which is
      different from the source directory (this.backup.sourcePath). Thus we also trim the path to this directory*/
    paths = paths.map(
      (a: string)=>{
        return a.replace(tempDataDirectoryPath, "");
    });


    this.createIBB_file(i, paths, this.backup.targetPath, nextDiscNumber).then(()=>{
      loadingDialogRef.close();
    }).catch((error)=>{
      loadingDialogRef.close();
      const errorDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
      errorDialog.componentInstance.title = "Error";
      errorDialog.componentInstance.message = `An error occurred while creating the ImgBurn project: ${error}`;
    })
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


}
