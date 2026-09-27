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
import { WorkerListener, WorkerResponse, CreatedIbbProject, IncompleteSplitFile } from '../../../app/workers/ipc.interfaces';
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
import { withLinksLeftOutNote } from '../shared/utils/links-note';
import { PIECE_ENDING, parsePiece, missingPieceNumbers, withoutPieceTotal, Piece } from '../../../app/workers/split-pieces';
import { OPTICAL_MEDIA, discContentBytes, mayBurnDisc } from '../shared/utils/optical-media';
import { OPTICAL_DRIVE_LETTER_CONVENTION } from '../shared/utils/disc-id-hash';
import { backedUpPath, confirmDiscNameAndPathLimits, isOriginalNamesList, metadataEntriesForDisc } from '../shared/utils/shortened-names';
import { metadataJsonFileName } from '../shared/utils/metadata-file-name';
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

  optical_media_choices = OPTICAL_MEDIA;

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
  /** Whether the user has confirmed disc i was actually burned - see confirmDiscBurned(). In-memory only: a job does
   *  not outlive the app. If the app closes mid-job, the discs confirmed so far are in the updated metadata JSON, and
   *  running this wizard again with it burns the rest - see incompleteSplitFiles for a split file's missing pieces. */
  public confirmedDiscs: boolean[] = [];
  /** For each new disc i, the bare-relative (relative to this.backup.targetPath) large-file-split-partial paths
   *  actually created and burned for it - captured once in sendToImgBurn, since it can include a rare
   *  surplus partial (a "sliver" - see createOpticalMediaDiscPartials) never part of this.partitions[i] to begin with, so
   *  it can't be recovered later by re-deriving it from that. confirmDiscBurned reads this to know exactly
   *  which real temp-dir files to delete. */
  private sentDiscPartPaths: string[][] = [];
  /** How many links the scan of the source ("master") left out - links are never backed up; see linksLeftOutNote. */
  private linksLeftOut = 0;
  /** Serializes recordConfirmedDisc's read-modify-write of the shared cold storage metadata JSON - see SerialQueue's
   *  own doc comment for why this is needed (one disc's "Try again" can still be writing when the next disc is
   *  confirmed). */
  private metadataUpdateQueue = new SerialQueue();
  /** New disc i's entry for the cold storage metadata JSON - its files with their real sizes and hashes - made when
   *  it is sent to ImgBurn, and written to the JSON once it is confirmed burned (see recordConfirmedDisc). */
  private discMetadataEntries: Array<Array<filesMetadata> | undefined> = [];
  /** Large files of the master only some of whose pieces are in the cold storage - an earlier job ended before the
   *  rest were burned (see replacePartialFileSplits). Listed as missing; planning then burns only their missing
   *  pieces. */
  private incompleteSplitFiles: IncompleteSplitFile[] = [];
  /** New discs whose "Confirm disc burned" is still running - see confirmDiscBurned. */
  private discsBeingConfirmed = new Set<number>();
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
  /** The selected medium's raw capacity, discounted by its maxRepletionRatio (see OPTICAL_MEDIA) - see
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
    loadingDialogRef.componentInstance.message = `Files too large for one disc are split into 500 MB pieces, in a folder ` +
      `of their own under ${tempDataDirectoryPath}. A disc's pieces are created when you send it to ImgBurn and deleted ` +
      `when you confirm it burned; the app offers to clear any left over at its next start.`;
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
   * trap: Electron's save dialog re-opens in the last folder used by a dialog in this app - which, right after
   * getJSON() ran, is the very folder the original file lives in. So without this, the dialog would often pre-fill
   * to the exact original path, and a user who just clicks "Save" would unknowingly overwrite the file they loaded
   * from - even though they were technically asked. Without a loaded JSON (the discs were read), the collection's
   * name gives the file name, as for a new backup (see metadataJsonFileName). */
  private suggestedUpdatedMetadataSavePath(): string {
    if (!this.externalMetadataJSONpath) {
      return metadataJsonFileName(this.coldStorageCollectionName, ' - updated');
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
        infoDialog.componentInstance.message = `Choose where to save the updated metadata JSON to continue.`;
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
        warnDialog.componentInstance.message = `This is the JSON you loaded (${chosenPath}). Saving here replaces it with the updated one.`;
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

  /** The cold storage's entries (`coldStoragePaths`, in the "D:\" form) as files of the master: the pieces of a split
   *  large file are replaced by the file itself, from `masterPaths` - backed up, if all of its pieces are there. A file
   *  only some of whose pieces are there (each piece's name says how many there are - see split-pieces.ts) is left
   *  out instead, so it is listed as missing, and noted in incompleteSplitFiles with the pieces it has: planning then
   *  burns only the others. Pieces named without their total (discs burned before it was added) count as all there;
   *  pieces of a file no longer in the master stay as they are. */
  private replacePartialFileSplits(coldStoragePaths: filesMetadata[], masterPaths: filesMetadata[]): filesMetadata[] {
    // Every recorded path starts with OPTICAL_DRIVE_LETTER_CONVENTION ("D:\"); a JSON with no disc recorded yet (none
    // confirmed burned) has no path to read it from.
    this.opticalDiscVolumeLetter = (coldStoragePaths.length > 0 ? coldStoragePaths[0].path : OPTICAL_DRIVE_LETTER_CONVENTION).split('\\')[0];
    // Without a trailing backslash whether or not targetPath has one (a drive root such as "D:\" always does), so
    // what is left after stripping it is "\dir\file" in every case - the form the cold storage paths take once
    // their volume letter is stripped.
    const targetPathWithoutTrailingBackslash = this.backup.targetPath.replace(/\\+$/, '');
    let r: filesMetadata[] = [];
    const piecesByFile = new Map<string, Array<{ entry: filesMetadata, piece: Piece }>>();
    for (const itm of coldStoragePaths) {
      const piece = parsePiece(itm.path.replace(this.opticalDiscVolumeLetter, ""));
      if (piece === null) { r.push(itm); continue; }
      (piecesByFile.get(piece.file) ?? piecesByFile.set(piece.file, []).get(piece.file)!).push({ entry: itm, piece });
    }
    this.incompleteSplitFiles = [];
    const masterByPath = new Map(masterPaths.map((o) => [o.path.replace(targetPathWithoutTrailingBackslash, ""), o]));
    for (const [file, pieces] of piecesByFile) {
      const largeFile = masterByPath.get(file);
      if (largeFile === undefined) {
        r.push(...pieces.map((p) => p.entry));
        continue;
      }
      const total = pieces.find((p) => p.piece.total !== undefined)?.piece.total;
      if (total !== undefined && missingPieceNumbers(total, pieces.map((p) => p.piece.number)).length > 0) {
        this.incompleteSplitFiles.push({ path: largeFile.path, total,
          burnedPieces: pieces.map((p) => ({ number: p.piece.number, sha256: p.entry.stats.sha256 })) });
        continue;
      }
      largeFile.path = largeFile.path.replace(targetPathWithoutTrailingBackslash, this.opticalDiscVolumeLetter)
      r.push(largeFile);
    }

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
      loadingDialogRef.componentInstance.title = "Missing fields";
      loadingDialogRef.componentInstance.message = `You have not filled all of the required fields.`;
    }else{
      if(this.json_coldStorageFilesMetadata){
        // Empty entries at the end are discs planned but never confirmed burned (the app was closed first): dropped, so
        // new discs take their numbers. One before a burned disc stays - it keeps that disc's number.
        const metadata = this.json_coldStorageFilesMetadata;
        let discCount = metadata.length;
        while (discCount > 0 && metadata[discCount - 1].length === 0) { discCount--; }
        this.entireColdStorageMetadata = metadata.slice(0, discCount);
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

  /** Scans the master directory (ipc.getFilePathsWithStats) behind a LoadingDialogComponent that shows a real,
   *  live percentage (see get-file-paths-with-stats in worker.ts, which probes the real total upfront via
   *  countAllFilesQuick before scanning - see its own doc comment) - this is the most time-consuming step of
   *  this wizard's step_1, and previously ran with no visible feedback at all (the dialog diff() itself opens
   *  only starts AFTER this already-finished scan is passed into it). */
  private async scanMasterDirectoryWithProgress(): Promise<filesMetadata[]> {
    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
    loadingDialogRef.componentInstance.showCancelButton = false;
    loadingDialogRef.componentInstance.message = "Scanning master directory";
    const listener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        if (response.key === 'get-file-paths-with-stats' && response.status === 'running') {
          const lines = response.res as string[];
          if (lines.length > 0) {
            const progress = parseScanItemsProgress(lines[lines.length - 1]);
            if (progress) {
              loadingDialogRef.componentInstance.percent = Math.round((progress.current / progress.total) * 100);
            }
          }
        }
      });
    });
    try {
      // skipUnreadable: this is a backup SOURCE, so an entry that cannot be read is left out (and reported)
      // rather than making the whole scan fail.
      const response = await ipc.getFilePathsWithStats(this.backup.targetPath, true);
      this.linksLeftOut = response.linksLeftOut ?? 0;
      return response.res;
    } finally {
      listener.removeListener();
      loadingDialogRef.close();
    }
  }

  async diff(coldStoragePathsWithStats: filesMetadata[], masterPathsWithStats: filesMetadata[]){
    this.step='step_3';
    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
    loadingDialogRef.componentInstance.showCancelButton = false;
    loadingDialogRef.componentInstance.message = 'Comparing directories';
    this.masterPathsWithStats = masterPathsWithStats;
    await this.holdOn(500);
    // Compared by where each file was in the master when it was backed up - not where it is on its disc, which differs
    // for a name too long for a disc (see disc-names.ts). A disc's own list of those names is no file of the master.
    coldStoragePathsWithStats = coldStoragePathsWithStats
      .filter((e) => !isOriginalNamesList(e))
      .map((e) => ({ ...e, path: backedUpPath(e) }));
    let coldStoragePathsWithoutPartials = this.replacePartialFileSplits(coldStoragePathsWithStats, JSON.parse(JSON.stringify(masterPathsWithStats)));

    this.opticalDiscVolumeLetter = (coldStoragePathsWithoutPartials.length > 0 ? coldStoragePathsWithoutPartials[0].path : OPTICAL_DRIVE_LETTER_CONVENTION).split('\\')[0] + '\\';
    if (this.backup.targetPath[this.backup.targetPath.length - 1] != '\\') { this.backup.targetPath += "\\"; }

    // Deep copy because this will mutate the values;
    let masterPathsWithStats_ : filesMetadata[]= JSON.parse(JSON.stringify(this.masterPathsWithStats))
    // Set when a modified/out-of-sync file is found below - used after the loop to actually stop diff() from
    // continuing on to build and display a (truncated) missing-files tree, which it previously did regardless,
    // right after telling the user the operation could not proceed and was being cancelled.
    let outOfSync = false;
    // An explicit loop (rather than the plain .filter() this used to be) so this comparison - potentially over
    // tens of thousands of files - can report a real "i of N" percentage (the total, masterPathsWithStats_.length,
    // is already known upfront, unlike a disk scan) instead of running behind a plain indeterminate spinner, and
    // so it can periodically yield back to the renderer's event loop (a `setTimeout(0)` - there is no worker
    // thread to hand this off to, it's a pure in-memory comparison against already-loaded data) rather than
    // blocking the UI solid for the whole comparison.
    const totalFilesToCompare = masterPathsWithStats_.length;
    let missingFiles: filesMetadata[] = [];
    // By path, so each file is found at once however large the collection (paths are unique - see
    // replacePartialFileSplits).
    const coldStorageByPath = new Map(coldStoragePathsWithoutPartials.map((o) => [o.path, o]));
    let lastYield = performance.now();
    for (let index = 0; index < totalFilesToCompare; index++) {
      const file = masterPathsWithStats_[index];
      const b = coldStorageByPath.get(file.path.replace(this.backup.targetPath, this.opticalDiscVolumeLetter));
      if (b == undefined) {
        missingFiles.push(file); // missing
      } else if (!file.stats.isDirectory && ((new Date(file.stats.mtime).getTime() > new Date(b.stats.mtime).getTime()) || (file.stats.size != b.stats.size))) {
        // Only files are compared: an empty folder is backed up once it is on a disc. Its modified time changes
        // whenever something is put in it and taken out again, with nothing of it changed - as diff in worker.ts
        // treats an empty folder too.
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
        this.step = "step_4";
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `Some files already on your discs have changed in the master folder since ` +
          `they were burned. Adding files cannot fix that - burn a new backup instead.`;
        errorDialog.afterClosed().subscribe(()=>{
          // Exit to main menu.
          goToMainMenuAndReload(this.router);
        });
        break;
      } // else: backed up - not included

      // Progress shown, and the window let redraw, about every 50 ms - and on the very last item, so the bar reaches
      // 100%. Not every few items: each pause takes about 6 ms, longer than comparing thousands of files.
      const isLastItem = index === totalFilesToCompare - 1;
      if (performance.now() - lastYield >= 50 || isLastItem) {
        loadingDialogRef.componentInstance.percent = Math.round(((index + 1) / totalFilesToCompare) * 100);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }

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
        infoDialog.componentInstance.message = withLinksLeftOutNote(`Your cold storage is up to date: no files are missing from it.`, this.linksLeftOut);
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
      infoDialog.componentInstance.message = `Enter a name for this collection first.`;
      infoDialog.componentInstance.actionsNum = 1;
      infoDialog.componentInstance.action1Label = "Ok";
      infoDialog.componentInstance.action1Callback = () => { infoDialog.close(); }
      return;
    }

    this.isPartitioning = true;
    let partitionProgressListener: WorkerListener | undefined;
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
      loadingDialogRef.componentInstance.showCancelButton = false;
      loadingDialogRef.componentInstance.message = 'Planning discs';
      // Real 0-100% across partitionBackupToOpticalMedia's bin-packing loop ("Packing items (i of N)", one disc
      // at a time - see worker.ts). Its scan phase never runs here at all - selectedPathsWithMetadata below is
      // always passed as filesMetadata, which partitionBackupToOpticalMedia already has every path/stat it
      // needs from, so it skips scanning targetPath itself entirely (see its own doc comment) - unlike
      // backup-to-optical-media.component.ts's WriteToOpticalMediaProceed, which never supplies filesMetadata
      // and so does see a real scan phase (0-50%) ahead of packing (50-100%).
      partitionProgressListener = ipc.onResponseFromWorker((event, response) => {
        this.ngZone.run(() => {
          if (response.key === 'partition-backup-to-optical-media' && response.status === 'running') {
            const lines = response.res as string[];
            for (const line of lines) {
              const packProgress = parsePackingProgress(line);
              if (packProgress) {
                loadingDialogRef.componentInstance.percent = Math.round((packProgress.current / packProgress.total) * 100);
              }
            }
          }
        });
      });
      // By path, so each ticked file is found at once however large the master.
      const masterByPath = new Map(this.masterPathsWithStats.map((o) => [o.path, o]));
      let selectedPathsWithMetadata: filesMetadata[] = this.filesTree.getSelectedData()
        .map((m) => masterByPath.get(this.backup.targetPath.concat(m)))
        .filter((itm): itm is filesMetadata => itm !== undefined);
      console.log(selectedPathsWithMetadata);

      // Generated once per job (partition() is only ever called once per job - unlike backup-to-optical-
      // media.component.ts's WriteToOpticalMediaProceed, there is no "try without splitting, retry with
      // splitting" chain here to worry about reusing the same id across).
      this.tempSessionId = 'session-' + Date.now();

      // partitionBackupToOpticalMedia now plans using fast size ESTIMATES for any large-file split partials
      // (never invoking 7-Zip here) - the real split, and this.partitions' real sizes, only happen later, lazily,
      // disc by disc, in sendToImgBurn - see its own comment and createOpticalMediaDiscPartials in worker.ts.
      // A large file only some of whose pieces are on discs gets only its missing pieces planned (see incompleteSplitFiles).
      const incompleteSplitFilesSelected = this.incompleteSplitFiles.filter((f) => selectedPathsWithMetadata.some((s) => s.path === f.path));
      this.partitions =  (await ipc.partitionBackupToOpticalMedia(this.backup.targetPath, this.selected_optical_medium.capacity, this.selected_optical_medium.maxRepletionRatio, true, this.tempSessionId, selectedPathsWithMetadata, false, incompleteSplitFilesSelected)).res;
      console.log(this.partitions)

      // Names too long for a disc, and paths too long for some programs: the user is told about every one before
      // anything is written, and recommended to shorten them in the master first. The planned paths, relative to the
      // disc's root, trimmed the same way sendToImgBurn trims them.
      loadingDialogRef.close();
      let tempSessionDirectoryPath: string = (await ipc.getTempDataDirectoryPath()).res;
      if (!tempSessionDirectoryPath.endsWith('\\')) { tempSessionDirectoryPath += '\\'; }
      tempSessionDirectoryPath += this.tempSessionId + '\\';
      const plannedRelativePaths = this.partitions.flat().map((a) => a.path.replace(this.backup.targetPath, "").replace(tempSessionDirectoryPath, ""));
      if (!(await confirmDiscNameAndPathLimits(this.dialog, plannedRelativePaths, this.backup.targetPath, 'start "Add missing files" again'))) {
        return;
      }

      // Same effective (margin-discounted) capacity partitionBackupToOpticalMedia itself planned against - see
      // getEffectiveOpticalMediumCapacityInBytes in worker.ts. sendToImgBurn/maybeAppendOverflowDiscs must judge
      // whether a surplus sliver fits against this exact number, never the medium's raw capacity: that margin is
      // a general burn-safety feature, not something reserved for or spent by handling surplus slivers.
      this.effectiveMediaCapacityInBytes = (await ipc.getEffectiveOpticalMediumCapacity(this.selected_optical_medium.capacity, this.selected_optical_medium.maxRepletionRatio)).res;
      this.originalNumberOfDisksNeeded = this.partitions.length;

      // Scaffold write: existing discs unchanged, plus one empty placeholder per new disc. Each new disc's real
      // entry is filled in once it is confirmed burned (see recordConfirmedDisc) - mirrors
      // backup-to-optical-media.component.ts's identical scaffold-then-incremental pattern.
      const scaffold: ColdStorageMetadata = (JSON.parse(JSON.stringify(this.entireColdStorageMetadata)) as ColdStorageMetadata)
        .concat(Array(this.partitions.length).fill([]));
      await ipc.writeJSONtoDisk(this.coldStorageMetadataJSONPathToSave, JSON.stringify(scaffold, null, 2));

      this._disks = [...Array(this.partitions.length).keys()]
      this.sentDiscs = Array(this.partitions.length).fill(false);
      this.sendingDiscs = Array(this.partitions.length).fill(false);
      this.confirmedDiscs = Array(this.partitions.length).fill(false);
      this.sentDiscPartPaths = Array(this.partitions.length).fill(null).map(() => []);
      this.discMetadataEntries = Array(this.partitions.length).fill(undefined);
      this.step = "step_5";
      loadingDialogRef.close();

      const completing = incompleteSplitFilesSelected.length === 0 ? '' : ` ${incompleteSplitFilesSelected.length === 1
        ? 'One large file has only some of its pieces on your discs; only its missing pieces are'
        : `${incompleteSplitFilesSelected.length} large files have only some of their pieces on your discs; only their missing pieces are`} planned.`;
      let loadingDialogRef2 = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '600px'});
      loadingDialogRef2.componentInstance.title = "Cold storage metadata prepared";
      loadingDialogRef2.componentInstance.message = withLinksLeftOutNote(`The updated metadata JSON is saved to ` +
        `${this.coldStorageMetadataJSONPathToSave} - keep it for future updates. Each new disc is recorded in it when you ` +
        `confirm it burned; if you close the app before then, run "Add missing files" again with this JSON to burn the ` +
        `rest.${completing}`, this.linksLeftOut);
    } finally {
      this.isPartitioning = false;
      partitionProgressListener?.removeListener();
    }
  }

  /** The number of new disc `disk_id` in the collection: new discs go after the existing ones
   *  (entireColdStorageMetadata - its empty entries at the end already dropped, see step1). Burned into the disc's
   *  volume label, and the one every button and message of this wizard shows, so the screen and the labels on the
   *  discs always agree. It is also the disc's place in the JSON (partition()'s scaffold, recordConfirmedDisc) plus
   *  one - recovery asks for discs by this number. */
  getNextDiscNumber(disk_id: number): number {
    return this.entireColdStorageMetadata.length + disk_id + 1;
  }

  /** Computes and attaches a `sha256` hash to every non-directory entry of `finalStats` (mutated in place) -
   *  see computeSha256ForBackedUpFiles in worker.ts and its identical counterpart in
   *  backup-to-optical-media.component.ts. Must be called after createOpticalMediaDiscPartials has already
   *  produced this disc's real, final file list (every entry must already exist on disk, under
   *  this.backup.targetPath here rather than a "source" path), and before anything else about this disc (its
   *  label hash, its metadata JSON entry, its .ibb file) is computed from that list. Always runs - SHA-256
   *  integrity data is mandatory for every NEW disc, independently of whether the EXISTING discs being added
   *  to already carry SHA-256 hashes or not (an older cold storage backed up before this feature existed, or
   *  from before it became mandatory, simply has no recorded hash for those older entries - see
   *  verifyRecoveredFileIntegrity/the standalone verify wizard, which both already report that as "no
   *  integrity data available" per file rather than a failure). A no-op when finalStats has no non-directory
   *  entries. */
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
    // doc comment). Another disc can't be sent meanwhile anyway: discs are burned in order (mayBurnDisc). The
    // whole method body is wrapped so the guard covers the once-fired-and-forgotten createIBB_file chain too
    // (now awaited below) - resetting the flag before that had actually finished would reopen the exact narrow
    // window (no .ibb written yet) this guard exists to close.
    if (this.sendingDiscs[i]) { return; }
    if (!mayBurnDisc(this.dialog, i, this.confirmedDiscs, (d) => this.getNextDiscNumber(d))) { return; }
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
        errorDialog.componentInstance.message = `Could not check whether disc ${this.getNextDiscNumber(i)} was already sent: ${error}`;
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
        errorDialog.componentInstance.message = `Disc ${this.getNextDiscNumber(i)} has no files to send - this should never happen. Please try clicking "Send to ImgBurn" again.`;
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
        realStats = (await ipc.createOpticalMediaDiscPartials(this.backup.targetPath, bareRelativePaths, this.tempSessionId)).res;
      } catch (error) {
        // E.g. 7-Zip failed, a file was deleted since planning, or a large file changed size since planning (the
        // worker then refuses to split it) - the disc is not sent, and the message says why.
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `Could not prepare the files of disc ${this.getNextDiscNumber(i)}: ${error}`;
        errorDialog.componentInstance.actionsNum = 1;
        errorDialog.componentInstance.action1Label = "Ok";
        errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); };
        return;
      } finally {
        splitDialogRef.close();
      }

      // Split the response back into what this disc was actually planned to hold and any surplus sliver(s)
      // riding along with it (see createOpticalMediaDiscPartials's own comment) - a piece by its file and number, as
      // its real total can be one more than the planned one.
      const requestedPaths = new Set(bareRelativePaths.map(withoutPieceTotal));
      const normalStats = realStats.filter(e => requestedPaths.has(withoutPieceTotal(e.path)));
      const ownSurplusStats = realStats.filter(e => !requestedPaths.has(withoutPieceTotal(e.path)));
      const finalStats = normalStats.slice();

      // Never more on a disc than effectiveMediaCapacityInBytes - the rest is a safety margin. The plan counted everything
      // (the list of original names too - see discContentBytes); only files that grew since planning can make it more.
      if (discContentBytes(normalStats) > this.effectiveMediaCapacityInBytes) {
        this.pendingOverflowPartials = this.pendingOverflowPartials.concat(ownSurplusStats);
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        errorDialog.componentInstance.title = "Disc too full";
        errorDialog.componentInstance.message = `Disc ${this.getNextDiscNumber(i)} no longer fits: some of its files grew ` +
          `since the discs were planned. Start "Add missing files" again to plan them anew.`;
        errorDialog.componentInstance.actionsNum = 1;
        errorDialog.componentInstance.action1Label = "Ok";
        errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); };
        return;
      }

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
      const acceptedSurplusPartials: filesMetadata[] = [];
      for (const surplusPartial of candidateSurplusPartials) {
        if (discContentBytes(finalStats.concat([surplusPartial])) <= this.effectiveMediaCapacityInBytes) {
          finalStats.push(surplusPartial);
          acceptedSurplusPartials.push(surplusPartial);
        } else {
          this.pendingOverflowPartials.push(surplusPartial);
        }
      }
      // If this send fails from here on, the slivers it took wait for a disc again: sending this disc again does not
      // report them anew, as their file is already split.
      const returnAcceptedSlivers = () => { this.pendingOverflowPartials = acceptedSurplusPartials.concat(this.pendingOverflowPartials); };

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
        returnAcceptedSlivers();
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        errorDialog.componentInstance.title = "Error";
        errorDialog.componentInstance.message = `Could not compute SHA-256 hashes for disc ${this.getNextDiscNumber(i)}: ${error}`;
        errorDialog.componentInstance.actionsNum = 1;
        errorDialog.componentInstance.action1Label = "Ok";
        errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); };
        return;
      }

      // Only the disc's number: during a recovery the app recognizes each inserted disc by itself (a hash of its
      // contents, see getDiscIdHash) and asks for discs by this number.
      await new Promise<void>((resolve) => {
        const labelDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
        labelDialog.disableClose = true;
        labelDialog.componentInstance.title = "Disc label";
        labelDialog.componentInstance.message =
          `Write "Disc ${nextDiscNumber}" on this disc - recovery asks for discs by number.`;
        labelDialog.componentInstance.actionsNum = 1;
        labelDialog.componentInstance.action1Label = "Ok";
        labelDialog.componentInstance.action1Callback = () => {
          labelDialog.close();
          resolve();
        }
      });

      const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
      loadingDialogRef.componentInstance.showCancelButton = false;
      loadingDialogRef.componentInstance.message = "Preparing ImgBurn project";

      // What this disc needed created in the temp folder - split partials - deleted again once the disc is confirmed
      // burned (confirmDiscBurned).
      this.sentDiscPartPaths[i] = finalStats.filter(e => PIECE_ENDING.test(e.path)).map(e => e.path);

      // Awaited (previously fired-and-forgotten): see sendingDiscs's own doc comment for why this guard needs
      // this chain's real completion, not just its start, to reset on.
      await this.createIBB_file(i, finalStats.map(e => e.path), this.backup.targetPath, nextDiscNumber).then(async (project)=>{
        // This disc's entry for the metadata JSON - its files as they are on the disc (a name too long for a disc is
        // shortened there, with its original path recorded). Recorded once the disc is confirmed burned - see
        // recordConfirmedDisc.
        this.discMetadataEntries[i] = metadataEntriesForDisc(finalStats, project, this.opticalDiscVolumeLetter);
        this.sentDiscs[i] = true;
        loadingDialogRef.close();
        // Now that this disc has actually been sent, check whether every originally-planned new disc has (so no
        // further surplus slivers can still turn up) and, if pendingOverflowPartials is non-empty, append however
        // many extra discs are needed to burn them too - see maybeAppendOverflowDiscs's own comment.
        await this.maybeAppendOverflowDiscs();
      }).catch((error)=>{
        if (!this.sentDiscs[i]) { returnAcceptedSlivers(); }
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
    for (const partial of this.pendingOverflowPartials) {
      if (currentPartition.length > 0 && discContentBytes(currentPartition.concat([partial])) > this.effectiveMediaCapacityInBytes) {
        overflowPartitions.push(currentPartition);
        currentPartition = [];
      }
      currentPartition.push(partial);
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
        `A large file's pieces need more room than estimated: you now need ${newTotal} new discs in total (was ` +
        `${previousTotal}).`;
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
      this.discMetadataEntries.push(undefined);
    }
    this._disks = [...Array(newTotal).keys()];
  }

  /** Marks disc i (0-based within this.partitions, i.e. among the NEW discs being added) as confirmed-burned:
   *  deletes its real created split partials (if any) from the temp directory, marks it confirmed (the
   *  template grays out and disables its controls once confirmedDiscs[i] is true), then records it in the cold
   *  storage metadata JSON (see recordConfirmedDisc). Discs are confirmed in order, as they can only be sent in
   *  order (mayBurnDisc). */
  async confirmDiscBurned(i: number): Promise<void> {
    // A second click while this one still waits for the worker must not confirm (and record) the disc twice.
    if (!this.sentDiscs[i] || this.confirmedDiscs[i] || this.discsBeingConfirmed.has(i)) { return; }
    this.discsBeingConfirmed.add(i);
    try {
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
          warnDialog.componentInstance.message = `Disc ${this.getNextDiscNumber(i)} is recorded as burned, but some of its temporary pieces could not be deleted: ${result.message} The app offers to clear them at its next start.`;
          if (result.notClearedItems?.length) {
            warnDialog.componentInstance.lists = [{ label: `Not removed (${result.notClearedItems.length}):`, items: result.notClearedItems }];
          }
          warnDialog.componentInstance.actionsNum = 1;
          warnDialog.componentInstance.action1Label = "Ok";
          warnDialog.componentInstance.action1Callback = () => { warnDialog.close(); };
        }
      }
      this.confirmedDiscs[i] = true;
      await this.recordConfirmedDisc(i);
    } finally {
      this.discsBeingConfirmed.delete(i);
    }
  }

  /** Writes new disc i's entry to the cold storage metadata JSON, right when it is confirmed burned - also a disc
   *  holding only some pieces of a split large file, as recordConfirmedDisc in backup-to-optical-media.component.ts
   *  does: if the app is closed before the rest are burned, running this wizard again with this JSON finds the pieces
   *  still missing (replacePartialFileSplits) and burns them. Disc numbers shown to the user continue the existing
   *  collection's (getNextDiscNumber). */
  private async recordConfirmedDisc(i: number): Promise<void> {
    try {
      await this.metadataUpdateQueue.enqueue(async () => {
        const metadataJSON: ColdStorageMetadata = (await ipc.readJSONfromDisk(this.coldStorageMetadataJSONPathToSave)).res;
        // The scaffold written in partition() reserved index (existing disc count + i) for new disc i.
        metadataJSON[this.entireColdStorageMetadata.length + i] = this.discMetadataEntries[i] || [];
        // A disc appended for a sliver lies past the entries written when the discs were planned: no gaps (null) in
        // the array.
        for (let d = 0; d < metadataJSON.length; d++) { if (!Array.isArray(metadataJSON[d])) { metadataJSON[d] = []; } }
        await ipc.writeJSONtoDisk(this.coldStorageMetadataJSONPathToSave, JSON.stringify(metadataJSON, null, 2));
      });
    } catch (error) {
      const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
      errorDialog.componentInstance.title = "Error";
      errorDialog.componentInstance.message = `Could not record disc ${this.getNextDiscNumber(i)} in the cold storage ` +
        `metadata JSON, although confirmed burned: ${error}`;
      errorDialog.componentInstance.actionsNum = 2;
      errorDialog.componentInstance.action1Label = "Cancel";
      errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); };
      errorDialog.componentInstance.action2Label = "Try again";
      errorDialog.componentInstance.action2Callback = () => { errorDialog.close(); this.recordConfirmedDisc(i); };
    }
  }

    /*
  This creates an ImgBurn project. This will be used to send the files to ImbBurn.
  As for 'paths: Array<string>': An array of the paths to be written to the specific disk. Note that the paths are note full system paths,
  (for example C:\**\*\my_backup_dir\**\*\some_file). Rather they are of the form: my_backup_dir\**\*\some_file.
  This C:\**\*\ part of the path is given in sourcePath. nextDiscNumber is the caller's getNextDiscNumber, the
  same number the wizard shows for this disc.
  */
  async createIBB_file (disk_id:number, paths: Array<string>, sourcePath: string, nextDiscNumber: number): Promise<CreatedIbbProject>{
    const collectionName = this.coldStorageCollectionName.trim();
    const volumeLabel = (collectionName ? collectionName + ' ' : '') + 'Disc ' + nextDiscNumber;

    // A failure to START ImgBurn is not reported through this call: the worker shows it as an error dialog of its
    // own (see invokeImgBurnOnIBBFile in worker.ts), and clicking "Send to ImgBurn" again reopens the same .ibb file.
    // ipc.createIBB_file() resolves once the worker has finished building the .ibb file and invoking ImgBurn.
    return (await ipc.createIBB_file(disk_id, paths, sourcePath, this.tempSessionId, volumeLabel)).res;
  }


}
