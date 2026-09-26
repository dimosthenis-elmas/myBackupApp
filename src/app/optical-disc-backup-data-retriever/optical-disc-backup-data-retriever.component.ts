import { Component, NgZone, OnDestroy, OnInit, ViewChild, ElementRef } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { BackupService } from '../core/services/backup/backup.service';
import { ConfirmationDialogComponent } from '../shared/components/confirmation-dialog/confirmation-dialog.component';
import { LoadingDialogComponent } from '../shared/components/loading-dialog/loading-dialog.component';
import { WorkerCommunicator as ipc } from '../../../app/workers/worker-communicator'
import { WorkerListener, WorkerResponse } from '../../../app/workers/ipc.interfaces';
import { FilesTreeComponent } from '../files-tree/files-tree.component';
import { ScrollableListComponent } from '../scrollable-list/scrollable-list.component';
import { filesMetadata } from '../../types/interface';
import { ColdStorageMetadata } from '../../../app/workers/ipc.interfaces';
import { getDiscIdHash, OPTICAL_DRIVE_LETTER_CONVENTION } from '../shared/utils/disc-id-hash';
import { goToMainMenuAndReload } from '../shared/utils/go-to-main-menu';
import { parseProgressFromLine, parseScanItemsProgress } from '../shared/utils/progress-line';
import { formatMegabytes } from '../shared/utils/format-bytes';
import { applyOriginalNamesList, backedUpPath, confirmRecoveredPathLengths, isOriginalNamesList } from '../shared/utils/shortened-names';
import { confirmRecoveryFolderIsEmpty } from '../shared/utils/recovery-folder';
 
  @Component({
    selector: 'optical-disc-backup-data-retriever',
    templateUrl: './optical-disc-backup-data-retriever.html',
    styleUrls: ['./optical-disc-backup-data-retriever.scss'],
    providers: []
  })
  export class OpticalDiscBackupDataRetriever implements OnInit, OnDestroy{  

    step:string = 'step_1';
    allFilesSelected:boolean = true;
    opticalMediumLoaded:boolean = false;
    finishedReadingFilePaths=false;
    showLogs=false;
    mountedVolumeLetter="";
    // in selectedFilePathsWithExtraInfo, the 'extras' property contains the id of the optical disk in which the file in the 'path' resides.
    selectedFilePathsWithExtraInfo!:{path:string, extras: any}[]
    discIdsNeededForTheRecoveryOfSelectedFiles!: number[];
    discIdsWhoseFilesAreAlreadyRecovered: number[] = [];
    recoveredAllFilesFromAllDiscs:boolean = false;

    /* We use an id to distinguish each disk in case the user inserts the wrong disk.
    Note that we just use the disk's number of used blocks. This is not perfect and a more
    robust kind of identification for each disk might be needed, but for now we apply this rather simple
    idea.
    Also note that the positions in the array opticalDiskIds matter for theidentification.
    i.e: The first element is the id of disk_1 an so on.
    */
    opticalDiskIds:Array<number>=[];
    
    waitForDialog = () => {
      return new Promise<void>(async(resolve) =>{
        while(!this.dialogClosed){
          await this.holdOn();
        }
        resolve();
      });
    }
    dialogClosed=false;


    filesTreeNotLoaded=true;

    completeBackupFilePaths :Array<string> = [];
    coldStorageMetadataForAllOpticalDiscs: ColdStorageMetadata = [];

    /** Shown under the files tree: how many files the whole cold storage holds (each piece of a split large file
     *  counts, as that is what is on the discs) and their total size, as "n MB (m bytes)" (see formatMegabytes).
     *  Worked out once per listing - both places that fill coldStorageMetadataForAllOpticalDiscs assign a new array -
     *  not on every change detection. */
    get coldStorageTotals(): { files: number, size: string } {
      if (this.coldStorageTotalsFor !== this.coldStorageMetadataForAllOpticalDiscs) {
        const files = this.coldStorageMetadataForAllOpticalDiscs.flat().filter((e) => !e.stats.isDirectory && !isOriginalNamesList(e));
        this.coldStorageTotalsCache = { files: files.length, size: formatMegabytes(files.reduce((sum, e) => sum + Number(e.stats.size), 0)) };
        this.coldStorageTotalsFor = this.coldStorageMetadataForAllOpticalDiscs;
      }
      return this.coldStorageTotalsCache;
    }
    private coldStorageTotalsFor?: ColdStorageMetadata;
    private coldStorageTotalsCache = { files: 0, size: formatMegabytes(0) };

    discIdsForCompleteBackupFilePaths :Array<number> = [];
    filesTreeRef!: FilesTreeComponent;
    myScrollContainerRef!: ElementRef;
    scrollableLogsListRef!:ScrollableListComponent;

    holdOn = () => {
      return new Promise<void>(resolve =>
        setTimeout(() => {
          resolve();
        },1000)
      );
    }
    workerListener!: WorkerListener;
    copyingPromise!: Promise<WorkerResponse>;
    finishedCopyingFiles: boolean = false;
    /** Real percentage (0-100) for the current disc's recovery copy, derived from the "(i of N)" progress
     *  marker createTree (worker.ts) pushes once per item copied - see parseProgressFromLine (shared/utils) and
     *  recoverAllFilesFromAllDiscs's 'incremental-copy-files' case below. Reset to 0 at the start of each
     *  disc's copy. */
    percentComplete: number = 0;
    /** Real percentage (0-100) for createFilesTreeForReconstructedBackupPaths's tree-building step - see
     *  FilesTreeComponent.buildProgress. Separate field from percentComplete above (recovery copy progress):
     *  the two never show at the same time (different steps of the wizard) but keeping them distinct avoids any
     *  confusion about which operation a given value belongs to. */
    treeBuildPercentComplete: number = 0;
    /** Real (0-100) percentage for whichever disc scan (get-file-paths-with-stats/get-file-paths) is currently
     *  running - both probe their real total upfront (see countAllFilesQuick/parseScanItemsProgress, worker.ts
     *  and shared/utils) rather than only reporting an open-ended running count. Undefined between scans, so
     *  the template only shows a progress bar while one is actually in progress. */
    scanPercentComplete?: number;

    constructor(public router: Router, private route: ActivatedRoute, public dialog: MatDialog, public backup: BackupService,
     private ngZone: NgZone, private eleRef: ElementRef) {

    }

    @ViewChild(FilesTreeComponent)  set filesTree(v: FilesTreeComponent) {
      setTimeout(() => {
        this.filesTreeRef = v;
      }, 0);
    } 

    @ViewChild(ScrollableListComponent)  set scrollableLogsList(v: ScrollableListComponent) {
      setTimeout(() => {
        this.scrollableLogsListRef = v;
      }, 0);
    } 


    @ViewChild('scrollMe') set myScrollContainer(v: ElementRef){
      setTimeout(() => {
        this.myScrollContainerRef = v;
      }, 0);
    };

    ngOnInit(): void {
      this.backup.resetStream();

    }

    ngAfterViewInit(): void {
    
    }

    ngOnDestroy(): void {
      // leaving page ..
      ipc.stop();
      this.backup.resetStream();
      ipc.onDestroy();
    }

    // Source: https://stackoverflow.com/questions/6229197/how-to-know-if-two-arrays-have-the-same-values
    private arrayCompare(_arr1: any[], _arr2: any[]) {
      if (_arr1.length !== _arr2.length) {
          return false;
        }
      // .concat() to not mutate arguments
      const arr1 = _arr1.concat().sort();
      const arr2 = _arr2.concat().sort();
      
      for (let i = 0; i < arr1.length; i++) {
          if (arr1[i] !== arr2[i]) {
              return false;
          }
      }
      
      return true;
    }

    // Sort array1 (string[]), then sort array2(number[]) based on the indices (the exact swaps) of the sorted array1.
    private synchronizedSort(array1: string[], array2: number[]): [string[], number[]]{
      let indices = Array.from(array1.keys()).sort((a,b) => 
        array1[a].localeCompare(array1[b])),
        sortedArray1 = indices.map(i => array1[i]),
        sortedArray2 = indices.map(i => array2[i])
        return [sortedArray1, sortedArray2]
    }
    
    private getCombinedFilePathsFromAllOpticalDiscs_resolve = (any: {
        filesMetadata: ColdStorageMetadata; diskIds: number[];
      })=>{}

    getCombinedFilePathsFromAllOpticalDiscs(){
      this.readAllDiscsToReconstructTheCompleteBackupFilePaths();
      return new Promise<{"filesMetadata": ColdStorageMetadata; "discIds": number[]}>((resolve:any, reject) => {
        this.getCombinedFilePathsFromAllOpticalDiscs_resolve = resolve;
      });
    };

    /**
     * Seeds this component's state directly from a pre-loaded, already schema-validated ColdStorageMetadata JSON
     * (produced by "backup to optical media" or "add missing files to cold storage"), instead of physically
     * reading every disc one by one via readAllDiscsToReconstructTheCompleteBackupFilePaths.
     *
     * The disc id for each disc must be computed exactly the same way readAllDiscsToReconstructTheCompleteBackupFilePaths
     * computes it for a physically-read disc (a hash of the sorted, drive-letter-normalized paths) so that it matches
     * the id computed later, when the user actually inserts that physical disc, in recoverAllFilesFromAllDiscs.
     * The paths stored in the JSON are already written in that same OPTICAL_DRIVE_LETTER_CONVENTION-normalized
     * form (see sendToImgBurn in backup-to-optical-media.component.ts, and the equivalent write in
     * add-missing-files-to-optical-media-cold-storage.component.ts), so we hash them as-is, without re-adding a
     * drive-letter prefix.
     *
     * IMPORTANT: the order of discs in the JSON array must match the disc numbering physically labeled on the discs
     * (metadata[0] is "disc 1", metadata[1] is "disc 2", etc.) - see opticalDiskIds and recoverAllFilesFromAllDiscs.
     *
     * Returns false (and shows an error dialog) instead of mutating state if the metadata looks malformed - e.g. two
     * discs with files producing the same disc id (the same disc listed twice), which would otherwise silently
     * misattribute files to the wrong disc later on, since opticalDiskIds.indexOf(id) is used to label discs to the user.
     * Empty discs (never confirmed burned) are allowed, however many.
     */
    seedFromExternalMetadata(metadata: ColdStorageMetadata): boolean {
      let opticalDiskIds: number[] = [];
      let completeBackupFilePaths: string[] = [];
      let discIdsForCompleteBackupFilePaths: number[] = [];

      metadata.forEach((discFiles) => {
        // The id from every path on the disc, its list of original names included; the files to choose from where
        // they were in the folder backed up (see backedUpPath).
        let currentDiskId = this.getStringHash(discFiles.map(f => f.path).sort().toString());
        let filePaths = discFiles.filter(f => !isOriginalNamesList(f)).map(f => backedUpPath(f)).sort();

        opticalDiskIds.push(currentDiskId);
        completeBackupFilePaths = completeBackupFilePaths.concat(filePaths);
        discIdsForCompleteBackupFilePaths = discIdsForCompleteBackupFilePaths.concat(
          Array(filePaths.length).fill(currentDiskId)
        );
      });

      // Discs with no entries are left out: a disc the wizards never recorded (not confirmed burned - see
      // recordConfirmedDiscs) stays an empty entry, and all empty discs share one id - but they hold nothing to recover,
      // so no file can be attributed to the wrong one.
      const idsOfDiscsWithFiles = opticalDiskIds.filter((id, i) => metadata[i].length > 0);
      if(new Set(idsOfDiscsWithFiles).size !== idsOfDiscsWithFiles.length){
        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = `Error`;
        infoDialog.componentInstance.message = `The provided cold storage metadata JSON looks malformed: two or more discs produce
          the same identifier (for example, the same disc listed twice). Please check the JSON file and try again.`;
        infoDialog.componentInstance.actionsNum = 1;
        infoDialog.componentInstance.action1Label = "Ok";
        infoDialog.componentInstance.action1Callback = () => { infoDialog.close(); }
        return false;
      }

      this.opticalDiskIds = opticalDiskIds;
      this.completeBackupFilePaths = completeBackupFilePaths;
      this.discIdsForCompleteBackupFilePaths = discIdsForCompleteBackupFilePaths;
      this.coldStorageMetadataForAllOpticalDiscs = metadata;
      this.finishedReadingFilePaths = true;

      return true;
    }

    private recoverDataFromOpticalDiscBackup_resolve(){
      return;
    }

    recoverDataFromOpticalDiscBackup(selectedFilePathsWithExtraInfo: { path: string; extras: any; }[], dirToSaveFiles:string){
      this.selectedFilePathsWithExtraInfo = selectedFilePathsWithExtraInfo;
      this.backup.targetPath = dirToSaveFiles;
      return new Promise((resolve:any, reject:any) => {
        this.recoverDataFromOpticalDiscBackup_resolve = resolve;
      });
    };

    goToMainMenu(){
      goToMainMenuAndReload(this.router);
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

    scrollToBottom(): void {
      try {
        this.myScrollContainer.nativeElement.scrollTop = this.myScrollContainer.nativeElement.scrollHeight;
      } catch (err) { }
    }

    getDirToCopyRecoveredData():void{
      this.chooseDirectory().then((path)=>{
        if(path != undefined){
          this.backup.targetPath = path;
        }
      });
    }

    // Delegates to the shared implementation (see disc-id-hash.ts) so there is a single source of truth for
    // this algorithm - it is also used at burn time (backup-to-optical-media / add-missing-files-to-optical-
    // media-cold-storage) to show the user the same ID for physical disc labeling, and that only works if both
    // places compute it identically.
    getStringHash(str:string, seed = 0):number {
      return getDiscIdHash(str, seed);
    };

    stringArrayHasDuplicates(a:Array<string>): boolean{
        let check_duplicate_in_array = (input_array: Array<string>) => {
          input_array = input_array.sort();
          return input_array.reduce(
              (duplicated_elements:Array<string>, current_element, current_index, arr) => {
                  if (input_array[current_index] ===
                      input_array[current_index - 1]) {
                      duplicated_elements.push(current_element);
                      //Found duplicate, break early.Array has at least one duplicate.
                      arr.splice(1);
                  }
                  return Array.from(new Set(duplicated_elements));
              },
              []
          );
      };
      return (check_duplicate_in_array(a).length > 0);
    }

    askUserHowToProceedAfterErrorInStep2(): void{
      const confirmDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
      confirmDialog.disableClose = true;
      confirmDialog.componentInstance.message = `Please select how you want to proceed.`;
      confirmDialog.componentInstance.title = "Continuation of process"
      confirmDialog.componentInstance.actionsNum = 2;
      confirmDialog.componentInstance.action1Label = "All disks have been processed, proceed to the next steps.";
      confirmDialog.componentInstance.action1Callback = () => { 
        confirmDialog.close();
        this.getCombinedFilePathsFromAllOpticalDiscs_resolve({"filesMetadata" : this.coldStorageMetadataForAllOpticalDiscs,
           "diskIds": this.discIdsForCompleteBackupFilePaths});
        
      }
      confirmDialog.componentInstance.action2Label = "Continue reading the next discs";
      confirmDialog.componentInstance.action2Callback = () => { 
        confirmDialog.close();
        this.step = 'step_2';
        this.readAllDiscsToReconstructTheCompleteBackupFilePaths();
        
      }
    }



    async readAllDiscsToReconstructTheCompleteBackupFilePaths():Promise<void>{
      this.step = 'step_2'
      try {
        // Waiting for CD...
        this.opticalMediumLoaded=false;
        let response = await ipc.waitForOpticalDiskToBeMounted();
        this.opticalMediumLoaded=true;
        let mountedVolumeLetter: string = response.res._mounted;
        /*
        We use the paths of the contents (arranged in a single big string)
        for the identification of each disk.
        Also: Please read the note before the opticalDiskIds delcaration.
        */

        // Reading CD...
        this.finishedReadingFilePaths=false;
        this.scanPercentComplete = undefined;

        // File paths with stats is going to be used in case the user requests the contents of the entire multi optical disc cold storage via
        // the promise getCombinedFilePathsFromAllOpticalDiscs.
        // Normally the user will then use the stats to check if any of the files present in the cold storage has been modified in the master.
        // In such a case, the cold storage is out of spec and must be recreated from scratch again.
        // If the user just wants to recover the data in a cold storage (set of optical discs) we only need the file paths and not the stats (modified date, size etc).
        // Thus we keep both  filePathsWithStats and filePaths (created from filePathsWithStats by reducing), and use them accordingly.
        // scanListener shows this scan's own real percentage (see get-file-paths-with-stats in worker.ts) under
        // the "Reading data from the optical disc" text - a local listener (not this.workerListener, which this
        // method doesn't otherwise use) so it can't be clobbered by/clobber anything else.
        const scanListener = ipc.onResponseFromWorker((event, response) => {
          this.ngZone.run(() => {
            if (response.key === 'get-file-paths-with-stats' && response.status === 'running') {
              const lines = response.res as string[];
              if (lines.length > 0) {
                const progress = parseScanItemsProgress(lines[lines.length - 1]);
                if (progress) { this.scanPercentComplete = Math.round((progress.current / progress.total) * 100); }
              }
            }
          });
        });
        let filePathsWithStats: Array<{
          "path": string;
          "stats": {
              "size": number;
              "mtime": Date;
              "isDirectory": boolean;
          };
        }>;
        try {
          filePathsWithStats = (await ipc.getFilePathsWithStats(mountedVolumeLetter)).res
        } finally {
          scanListener.removeListener();
          this.scanPercentComplete = undefined;
        }
        let filePaths: string[] = [];
        filePaths = filePathsWithStats.reduce((acc: string[], obj) => {
          acc.push(obj.path);
          return acc;
        }, []);

        /* We want to create some kind of ID for each disc so that we can display useful messages to the user (for example: insert discs with id a,b,c etc.)
        For this reason we use a hash of the complete file paths contained in the optical medium. Becase we might get a different drive letter by the operating system
        we choose to replace E:\, G:\ or whatever with the fixed OPTICAL_DRIVE_LETTER_CONVENTION for the consistency of the IDs produced (see disc-id-hash.ts).*/
        filePaths = filePaths.map(x=>x.replace(/^(\w+\:\\)/, OPTICAL_DRIVE_LETTER_CONVENTION))
        let currentDiskId = this.getStringHash(filePaths.sort().toString())

        // Kept drive-letter-normalized, like filePaths above and like every path in a cold storage metadata
        // JSON: this list is what add-missing-files-to-optical-media-cold-storage.component.ts writes back out
        // as the updated JSON (and derives new discs' labels/ID hashes from), and a disc's ID is a hash of its
        // OPTICAL_DRIVE_LETTER_CONVENTION-prefixed paths - with the drive letter this disc happened to mount
        // as left in, those IDs would only match when the drive really is "D:".
        const normalizedFilePathsWithStats: filesMetadata[] = filePathsWithStats.map(f => ({
          ...f,
          path: f.path.replace(/^(\w+\:\\)/, OPTICAL_DRIVE_LETTER_CONVENTION)
        }));
        // A disc with names too long for a disc carries the list of their original names (see disc-names.ts): the
        // files to choose from are where they were in the folder backed up, as with a metadata JSON.
        const mountedRoot = mountedVolumeLetter.endsWith('\\') ? mountedVolumeLetter : mountedVolumeLetter + '\\';
        await applyOriginalNamesList(normalizedFilePathsWithStats,
          async (path) => (await ipc.readJSONfromDisk(path.replace(/^(\w+\:\\)/, mountedRoot))).res);
        const backedUpFilePaths = normalizedFilePathsWithStats.filter(f => !isOriginalNamesList(f)).map(f => backedUpPath(f)).sort();

        if(this.opticalDiskIds.includes(currentDiskId)){
          //"We have already processed this optical disk!"
          let currentDiskIndex = this.opticalDiskIds.indexOf(currentDiskId);  
          console.log("We have already processed this optical disk! " + (currentDiskIndex + 1).toString());

          const confirmDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
          confirmDialog.disableClose = true;
          confirmDialog.componentInstance.message = `It looks like you have already inserted this disc. It is disc ${currentDiskIndex + 1}
          as previously defined. Select 'Ok' to continue.`;
          confirmDialog.componentInstance.title = "Error"
          confirmDialog.componentInstance.actionsNum = 1;
          confirmDialog.componentInstance.action1Label = "Ok";
          confirmDialog.componentInstance.action1Callback = () => { 
            confirmDialog.close();
            this.askUserHowToProceedAfterErrorInStep2();
          }
          return;
        }

        if(this.stringArrayHasDuplicates(this.completeBackupFilePaths.concat(backedUpFilePaths))){
          /*Seems like this disk does not follow the specification.
          Every disk must contain unique file names. If there exist disks with common file names then
          these disks do not meet the requirements. They do not belong to a set of backup disks as defined here.
          */
        console.log("This disk has duplicates.")
          const confirmDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
          confirmDialog.disableClose = true;
          confirmDialog.componentInstance.message = `It looks like the disk you inserted has some files in common with disks you inserted
          previously. The application requires each disk to have unique filenames. Ignoring this disc.`;
          confirmDialog.componentInstance.title = "Error"
          confirmDialog.componentInstance.actionsNum = 1;
          confirmDialog.componentInstance.action1Label = "Ok";
          confirmDialog.componentInstance.action1Callback = () => { 
            confirmDialog.close();
            this.askUserHowToProceedAfterErrorInStep2();
          }
          return;

        }else{
          //Ok the disk provided meets the specs.
          //Add an id for the disk. Please read the comment before the this.opticalDiskIds declaration.
          this.opticalDiskIds.push(currentDiskId);
          //Add the paths to the complete backup.
          this.completeBackupFilePaths = this.completeBackupFilePaths.concat(backedUpFilePaths);
          this.coldStorageMetadataForAllOpticalDiscs = this.coldStorageMetadataForAllOpticalDiscs.concat([normalizedFilePathsWithStats]);

          this.discIdsForCompleteBackupFilePaths = this.discIdsForCompleteBackupFilePaths.concat(Array(backedUpFilePaths.length).fill(currentDiskId))

          this.finishedReadingFilePaths = true;
        

          // Waiting for eject CD...
          const confirmDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
          confirmDialog.disableClose = true;
          confirmDialog.componentInstance.message = `We will refer to the disc you just inserted as the disc ${this.opticalDiskIds.length}.
          Please remove the disc ${this.opticalDiskIds.length} from the drive and insert the next disc. Then press 'Ok' to continue the process.`;
          confirmDialog.componentInstance.title = "Accessing disc"
          confirmDialog.componentInstance.actionsNum = 2;
          confirmDialog.componentInstance.action2Label = "Ok"
          confirmDialog.componentInstance.action1Label = "All disks have been processed, continue to the next step"
          confirmDialog.componentInstance.action2Callback = () => { 
            confirmDialog.close();
            this.readAllDiscsToReconstructTheCompleteBackupFilePaths();
          }
          confirmDialog.componentInstance.action1Callback = () => { 
            confirmDialog.close();
            //console.log(this.coldStorageMetadataForAllOpticalDiscs)
            this.getCombinedFilePathsFromAllOpticalDiscs_resolve({"filesMetadata" : this.coldStorageMetadataForAllOpticalDiscs,
           "diskIds": this.discIdsForCompleteBackupFilePaths});
            //this.step = 'step_3';
            
            //this.createFilesTreeForReconstructedBackupPaths();
          }
        }    
        
      } catch (error) {
          const confirmDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
          confirmDialog.disableClose = true;
          confirmDialog.componentInstance.message = `An error occured while trying to read an optical disk. You may retry or cancel the entire operation.`;
          confirmDialog.componentInstance.title = "Error reading disk"
          confirmDialog.componentInstance.actionsNum = 2;
          confirmDialog.componentInstance.action2Label = "Retry"
          confirmDialog.componentInstance.action1Label = "Cancel"
          confirmDialog.componentInstance.action2Callback = () => { 
            confirmDialog.close();
            this.readAllDiscsToReconstructTheCompleteBackupFilePaths();
          }
          confirmDialog.componentInstance.action1Callback = () => {
            confirmDialog.close();
            goToMainMenuAndReload(this.router);
          }
      }

    }

    async createFilesTreeForReconstructedBackupPaths(){
      this.step = 'step_3';
      //Set tree data and display files tree for the complete backup combining all the disks read.
      
      // Wait a second for the viewChild to be loaded. Otherwise we get an error because this.filesTreeRef is undefined.
      // There might be a more elegant solution but still, this works. 
      await this.holdOn();
      this.filesTreeNotLoaded  = true;

      /* the response from the worker returns the full paths relative to the host file system.
          Since we are indifferent for the full system file structure we trim the mounting volume (e.g. D:\\)
          part from all paths. This way our root becomes the directory chosen by the user in the dialog.*/
          this.completeBackupFilePaths = this.completeBackupFilePaths.map(
            (x)=>{
              return x.split('\\').slice(1).join('\\');              
            }
          );

      let synchedSort = this.synchronizedSort(this.completeBackupFilePaths, this.discIdsForCompleteBackupFilePaths);
      let sortedCompleteBackupFilePaths = synchedSort[0];
      let sortedDiscIdsForCompleteBackupFilePaths = synchedSort[1];

      this.treeBuildPercentComplete = 0;
      const buildProgressSubscription = this.filesTreeRef.buildProgress.subscribe((percent) => {
        this.treeBuildPercentComplete = percent;
      });
      try {
        await this.filesTreeRef.setTreeData(sortedCompleteBackupFilePaths, sortedDiscIdsForCompleteBackupFilePaths);
      } finally {
        buildProgressSubscription.unsubscribe();
      }
      this.selectAllFiles(false);
      this.filesTreeRef.expandAllNodes();
      this.filesTreeNotLoaded  = false;
    }

    async getPathsOfFilesToBeRecovered(){
      const selected: {path: string, extras: any}[] = this.filesTreeRef.getSelectedFilePathsIncludingExtraInfo();
      const chooseAnotherFolderAndStartAgain = async () => {
        const folder = await this.chooseDirectory();
        if (folder) {
          this.backup.targetPath = folder;
          this.getPathsOfFilesToBeRecovered();
        }
      };
      if (selected.length > 0) {
        // Right before anything is copied: the recovery folder must be empty, so that no file already there is
        // replaced (it may have been chosen long before, or be the folder just chosen below).
        const folderState = await confirmRecoveryFolderIsEmpty(this.dialog, this.backup.targetPath, true);
        if (folderState !== 'empty') {
          if (folderState === 'choose-folder') { await chooseAnotherFolderAndStartAgain(); }
          return;
        }
        // Recovered paths too long for most programs: the user is told about every one, and recommended to pick a
        // folder with a shorter path - then asked again, for that folder.
        if ((await confirmRecoveredPathLengths(this.dialog, selected.map(x => x.path), this.backup.targetPath)) === 'choose-folder') {
          await chooseAnotherFolderAndStartAgain();
          return;
        }
      }
      this.selectedFilePathsWithExtraInfo = selected;
      console.log(this.selectedFilePathsWithExtraInfo)
      if(this.selectedFilePathsWithExtraInfo.length > 0){
        this.discIdsNeededForTheRecoveryOfSelectedFiles = [...new Set(this.selectedFilePathsWithExtraInfo.map((item: { extras: any; }) => item.extras))];
        
        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = `Data recovery from optical media backup`;
        infoDialog.componentInstance.message = 
        `To recover the files you selected you will now need to insert the following discs, (in any order you like):
        ${JSON.stringify(
          this.discIdsNeededForTheRecoveryOfSelectedFiles.map((x)=>{
            return 'disc ' + (this.opticalDiskIds.indexOf(x) + 1).toString(); 
          })
          )
        } 
        , as these were defined in the previous steps of the process.`
        infoDialog.componentInstance.actionsNum = 1;
        infoDialog.componentInstance.action1Label = "Ok";
        infoDialog.componentInstance.action1Callback = () => { 
          infoDialog.close();
          this.recoverAllFilesFromAllDiscs();
        }


      }else{
        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.message = `You have not selected any files.`;
        infoDialog.componentInstance.title = "Recover data"
        infoDialog.componentInstance.actionsNum = 1;
        infoDialog.componentInstance.action1Label = "Ok";
        infoDialog.componentInstance.action1Callback = () => { 
          infoDialog.close();
        }
      }
    }

    async recoverAllFilesFromAllDiscs(){
      this.finishedCopyingFiles = false;
      this.percentComplete = 0;
      ipc.stop();

      this.step='step_5';
      this.opticalMediumLoaded = false;
      this.showLogs=false;

      // Wait for optical disk to be loaded.
      let response = await ipc.waitForOpticalDiskToBeMounted();
      this.mountedVolumeLetter = response.res._mounted;
      this.opticalMediumLoaded=true;

      //Get the id of the disc inserted
      // Shares the SAME progress bar the actual recovery copy below drives (percentComplete/step_5's template) -
      // without this, that bar sat frozen at 0% (set just above) for this entire scan, which reads as more
      // broken/stalled than a plain spinner would have, rather than as "loading". get-file-paths probes its
      // real total upfront (see countAllFilesQuick/parseScanItemsProgress, worker.ts/shared/utils), so this is a
      // genuine percentage, not an estimate. Reset back to 0 below once the real copy phase actually starts.
      const scanListener = ipc.onResponseFromWorker((event, response) => {
        this.ngZone.run(() => {
          if (response.key === 'get-file-paths' && response.status === 'running') {
            const lines = response.res as string[];
            if (lines.length > 0) {
              const progress = parseScanItemsProgress(lines[lines.length - 1]);
              if (progress) { this.percentComplete = Math.round((progress.current / progress.total) * 100); }
            }
          }
        });
      });
      let filePaths: string[] = [];
      try{
        filePaths = (await ipc.getFilePaths(this.mountedVolumeLetter)).res;
      } catch (error) {
        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = `Error`;
        infoDialog.componentInstance.message = `An error occurred, Please try again. ${error}`;
        infoDialog.componentInstance.actionsNum = 1;
        infoDialog.componentInstance.action1Label = "Retry";
        infoDialog.componentInstance.action1Callback = async () => {
          infoDialog.close();
          this.recoverAllFilesFromAllDiscs();
        }
        return;
      } finally {
        scanListener.removeListener();
        this.percentComplete = 0; // reset - the actual recovery copy phase below drives this same bar from 0 again.
      }

      /* We want to create some kind of ID for each disc so that we can display useful messages to the user (for example: insert discs with id a,b,c etc.)
        For this reason we use a hash of the complete file paths contained in the optical medium. Becase we might get a different drive letter by the operating system
        we choose to replace E:\, G:\ or whatever with the fixed OPTICAL_DRIVE_LETTER_CONVENTION for the consistency of the IDs produced (see disc-id-hash.ts).
        The paths must also be sorted before hashing: ipc.getFilePaths (getAllFiles in worker.ts) returns them in
        plain fs.readdirSync order, which is not guaranteed to match the order they were in when this same disc's
        ID was originally computed (readAllDiscsToReconstructTheCompleteBackupFilePaths / seedFromExternalMetadata /
        the burn-time labeling dialogs - see their own sort() calls and seedFromExternalMetadata's doc comment).
        Without sorting here too, re-inserting the exact same disc could hash to a different ID and be rejected
        as "wrong disc" even though it genuinely has the requested files. */
      filePaths = filePaths.map(x=>x.replace(/^(\w+\:\\)/, OPTICAL_DRIVE_LETTER_CONVENTION));
      let currentDiskId = this.getStringHash(filePaths.sort().toString());
      let currentDiscIdIsOneOfRequired = this.discIdsNeededForTheRecoveryOfSelectedFiles.indexOf(currentDiskId);

      // If the inserted disc is not in the set of discs required to recover the data...
      if(currentDiscIdIsOneOfRequired == -1){
        this.dialogClosed=false;
        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = `Error`;
        infoDialog.componentInstance.message = `This disc does not seem to contain any of the files you requested to recover.
         Are you sure you have inserted the correct disc?. You must insert one of:  
        ${JSON.stringify(
          this.discIdsNeededForTheRecoveryOfSelectedFiles.filter( ( el ) => {
            return this.discIdsWhoseFilesAreAlreadyRecovered.indexOf( el ) < 0;
          } ).map((x)=>{
            return 'disc ' + (this.opticalDiskIds.indexOf(x) + 1).toString(); 
          })
          )}  as these were defined previously.`;
        infoDialog.componentInstance.actionsNum = 1;
        infoDialog.componentInstance.action1Label = "Retry";
        infoDialog.componentInstance.action1Callback = () => { 
          infoDialog.close();
          this.dialogClosed=true;
          this.recoverAllFilesFromAllDiscs();
          
        }
        await this.waitForDialog();
        return;
      }

      // If the inserted disc files have already been recovered.
      if(this.discIdsWhoseFilesAreAlreadyRecovered.indexOf(currentDiskId) >=0){
        this.dialogClosed=false;
        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = `Error`;
        infoDialog.componentInstance.message = `It looks like you have already recovered the files from this disc. Please insert another disc from:  
        ${JSON.stringify(
          this.discIdsNeededForTheRecoveryOfSelectedFiles.filter( ( el ) => {
            return this.discIdsWhoseFilesAreAlreadyRecovered.indexOf( el ) < 0;
          } ).map((x)=>{
            return 'disc ' + (this.opticalDiskIds.indexOf(x) + 1).toString(); 
          })
          )} as these were defined previously.`;
        infoDialog.componentInstance.actionsNum = 1;
        infoDialog.componentInstance.action1Label = "Retry";
        infoDialog.componentInstance.action1Callback = () => {
          infoDialog.close();
          this.dialogClosed=true;
          this.recoverAllFilesFromAllDiscs();
        }
        await this.waitForDialog();
        return;
      }

      // Clear the logs stream
      this.backup.resetStream();

      // Create a listener for theworker  responses.
      this.workerListener = ipc.onResponseFromWorker((event, response) => {
        this.ngZone.run(() => {
          switch (response.key) {
            case 'incremental-copy-files':
              if(response.status == 'running'){
                // Split out the per-item "(i of N)" progress marker (see createTree in worker.ts) from the
                // rest of this batch's descriptive lines before printing to the scrollable list logs - it
                // drives percentComplete below, not one more visible log line.
                const visibleLines = (response.res as string[]).filter((line) => {
                  const progress = parseProgressFromLine(line);
                  if (progress) {
                    this.percentComplete = Math.round((progress.current / progress.total) * 100);
                    return false;
                  }
                  return true;
                });
                if (visibleLines.length > 0) { this.backup.previewLogsStream.next(visibleLines); }
              }else if(response.status == 'completed' || response.status == 'stopped'){
                this.backup.previewLogsStream.complete();
                this.discIdsWhoseFilesAreAlreadyRecovered.push(currentDiskId);
                if(this.arrayCompare(this.discIdsNeededForTheRecoveryOfSelectedFiles, this.discIdsWhoseFilesAreAlreadyRecovered)){
                  // Finished recovering data from all disks! Before declaring success, check whether the user
                  // selected any partial (.part.NNN) files - pieces of a large file that did not fit on a single
                  // disc - and, if so, offer to reassemble the original file from them.
                  this.finishRecoveryAfterOptionalMerge();
                }else{
                  this.finishedCopyingFiles = true;
                }
              }           
              break;
            default:
              // One call, not two (used to be a separate console.error(response) right after) - each
              // console.error now also shows a dialog, so two calls for what is conceptually one event would
              // have shown the user two dialogs back to back for it.
              console.error('The app received an unexpected internal message and may be out of sync. It is best to restart it.', response);
              break;
          }
        });
      });



      // Filter paths for the requested disk number.
      let selectedPathsPresentInTheInsertedDisk = this.selectedFilePathsWithExtraInfo.filter((
        res: { path:string, extras: any; })=>{
          return res.extras==currentDiskId;
        }).map((e)=>{
          return e.path
        });

      

      // Where each of them is on the disc, when that is not where it goes - its name was too long for a disc and
      // shortened there (see disc-names.ts); it is recovered under its original name.
      // (coldStorageMetadataForAllOpticalDiscs is in the order of opticalDiskIds.)
      const onDiscByBackedUpPath = new Map<string, string>();
      (this.coldStorageMetadataForAllOpticalDiscs[this.opticalDiskIds.indexOf(currentDiskId)] || []).forEach((e) => {
        const backedUp = backedUpPath(e);
        if (backedUp !== e.path) { onDiscByBackedUpPath.set(backedUp.replace(/^(\w+\:\\)/, ''), e.path.replace(/^(\w+\:\\)/, '')); }
      });
      const sourcePaths: { [path: string]: string } = {};
      selectedPathsPresentInTheInsertedDisk.forEach((p) => {
        const onDisc = onDiscByBackedUpPath.get(p);
        if (onDisc !== undefined) { sourcePaths[p] = onDisc; }
      });

      // Send request to worker to copy the selected files to target.
      this.showLogs=true;
      this.copyingPromise = ipc.incrementalCopyFiles(selectedPathsPresentInTheInsertedDisk, this.mountedVolumeLetter, this.backup.targetPath, undefined, sourcePaths);
      // The copy's failure arrives as a rejection of this promise, not as a throw from the call above (so a
      // surrounding try/catch would never see it). Without a handler it was an unhandled rejection: a generic
      // "something unexpected went wrong" dialog, and a wizard left showing a progress bar that never finishes
      // with no way forward. The worker's success/stop messages (see the listener registered above) never arrive
      // for a failed copy, so this is also where the log list gets its end.
      this.copyingPromise.catch((error) => {
        this.ngZone.run(() => {
          this.backup.previewLogsStream.complete();
          const errorDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
          errorDialog.disableClose = true;
          errorDialog.componentInstance.title = `Error while recovering from this disc`;
          errorDialog.componentInstance.message =
            `Not all of the selected files could be copied from this disc: ${error}. Files that were already ` +
            `copied are kept. A dirty or scratched disc is a common cause, and so is a full or unavailable ` +
            `destination folder. You can try this disc again, or cancel the recovery.`;
          errorDialog.componentInstance.actionsNum = 2;
          errorDialog.componentInstance.action1Label = "Cancel recovery";
          errorDialog.componentInstance.action1Callback = () => {
            errorDialog.close();
            this.goToMainMenu();
          }
          errorDialog.componentInstance.action2Label = "Try this disc again";
          errorDialog.componentInstance.action2Callback = () => {
            errorDialog.close();
            this.recoverAllFilesFromAllDiscs();
          }
        });
      });

    }

    /** Called once every disc needed for the recovery has been processed. Offers to reassemble any selected
     *  partial (.part.NNN) files into their original large file first, then shows the "recovery successful"
     *  dialog. This runs after all discs are done specifically because a large file's parts can be spread
     *  across different discs (the disc-packing in partitionBackupToOpticalMedia treats each part as just
     *  another file when filling up a disc) - so we can only be sure every part the user selected has actually
     *  been copied to this.backup.targetPath once the whole recovery is complete. */
    private async finishRecoveryAfterOptionalMerge(): Promise<void> {
      // MUST run before offerToMergeAnyPartialFiles, not after: a successful merge DELETES the individual
      // .partNNN pieces it just reassembled (see mergePartialFileGroupSilently), and there is no separate
      // recorded hash for the reassembled WHOLE file to check instead - only each physical piece has one (see
      // the granularity decision this feature was built around). Verifying after the merge would find those
      // piece paths simply gone and report every merged file as FAILED, always, regardless of whether anything
      // was ever actually wrong - checking the raw, still-on-disk copied pieces first (closest to what was
      // actually read off the disc) avoids that entirely, and is arguably the more correct place for it anyway:
      // this confirms the COPY was byte-correct, independently of the merge's own separate 7-Zip integrity test.
      const integrity = await this.verifyRecoveredFileIntegrity();
      await this.offerToMergeAnyPartialFiles();

      const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '600px'});
      infoDialog.disableClose = true;
      const anyFailed = !!integrity && integrity.failed.length > 0;
      // Never say plain "successful" if any file FAILED integrity verification - same rule offerToMergeAnyPartialFiles's
      // own summary follows (see showMergeSummary), so a real problem can never be masked by an upbeat title.
      infoDialog.componentInstance.title = anyFailed ? `Data recovery finished with integrity FAILURES` : `Data recovery successful`;
      let message = `The recovery of your data has been completed successfully!`;
      if (integrity) {
        message = anyFailed
          ? `The recovery finished, but SHA-256 integrity verification found one or more problems - see the full recovered file paths below.`
          : `The recovery of your data has been completed successfully, and SHA-256 integrity verification confirmed every file with recorded hash data matches.`;
        // Full lists, not a truncated "first 15, and N more" string - see ConfirmationDialogComponent's own
        // `lists` field: each renders as a real virtualized scrolling list, so however many files are in a
        // given category, only the ones actually visible are ever real DOM nodes. Only non-empty sections are
        // included (an empty `items` array is never shown, per that field's own contract). Every entry is the
        // file's full absolute path (see verifyRecoveredFileIntegrity), not just its name.
        infoDialog.componentInstance.lists = [
          integrity.failed.length ? { label: `FAILED integrity check (${integrity.failed.length}) - this can mean real data corruption (a bad drive read, disc handling damage):`, items: integrity.failed } : undefined,
          integrity.verified.length ? { label: `Verified (${integrity.verified.length}):`, items: integrity.verified } : undefined,
          integrity.noData.length ? { label: `No integrity data available, not checked (${integrity.noData.length}):`, items: integrity.noData } : undefined,
        ].filter((s): s is { label: string, items: string[] } => !!s);
      }
      infoDialog.componentInstance.message = message;
      infoDialog.componentInstance.actionsNum = 1;
      infoDialog.componentInstance.action1Label = "Ok";
      if (anyFailed) {
        // Offered only when there is something to delete, and defaults unchecked - deleting recovered data is
        // never done unless the user explicitly opts into it right here.
        infoDialog.componentInstance.checkboxLabel = 'Delete all the recovered files which did not pass the verification test.';
        infoDialog.componentInstance.checkboxChecked = false;
      }
      infoDialog.componentInstance.action1Callback = async () => {
          infoDialog.close();
          if (anyFailed && infoDialog.componentInstance.checkboxChecked) {
            await this.deleteFailedIntegrityFiles(integrity!.failed);
          }
          this.finishedCopyingFiles = true;
          this.recoveredAllFilesFromAllDiscs = true;
        }
    }

    /** Deletes exactly the recovered files that FAILED SHA-256 verification - the same full absolute paths
     *  just shown to the user in the "FAILED integrity check" list above, nothing more. Only ever called when
     *  the user explicitly ticked the "Delete all the recovered files which did not pass the verification
     *  test." checkbox; the actual safety checks (only real, on-disk files strictly inside the recovery target
     *  directory are ever touched - never a directory, a symlink, or anything outside it) live in
     *  deleteRecoveredFailedFiles in worker.ts, run on the worker side so they cannot be bypassed by anything
     *  going wrong here in the renderer. */
    private async deleteFailedIntegrityFiles(failedAbsolutePaths: string[]): Promise<void> {
      let result: { cleared: boolean, message: string, deletedItems: string[], notClearedItems: string[] };
      try {
        result = (await ipc.deleteRecoveredFailedFiles(failedAbsolutePaths, this.backup.targetPath)).res;
      } catch (error) {
        result = { cleared: false, message: `The deletion could not be completed: ${error}`, deletedItems: [], notClearedItems: [] };
      }
      await new Promise<void>((resolve) => {
        const resultDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '700px' });
        resultDialog.disableClose = true;
        resultDialog.componentInstance.title = result.cleared ? "Failed files deleted" : "Some failed files could not be deleted";
        resultDialog.componentInstance.message = result.message;
        resultDialog.componentInstance.lists = [
          result.notClearedItems?.length ? { label: `NOT deleted (${result.notClearedItems.length}):`, items: result.notClearedItems } : undefined,
          result.deletedItems.length ? { label: `Deleted (${result.deletedItems.length}):`, items: result.deletedItems } : undefined,
        ].filter((s): s is { label: string, items: string[] } => !!s);
        resultDialog.componentInstance.actionsNum = 1;
        resultDialog.componentInstance.action1Label = "Ok";
        resultDialog.componentInstance.action1Callback = () => { resultDialog.close(); resolve(); };
      });
    }

    /** Runs SHA-256 integrity verification (see verifyFileHashes in worker.ts) over every recovered file that
     *  has a stored hash - one line per physical recovered file (deliberately NOT grouped by logical/original
     *  file the way groupSelectedPartialFiles groups .part.NNN pieces for the separate merge offer below: the
     *  user needs to see, and be able to selectively delete, the exact physical file that actually failed, not
     *  a merged-file label that may cover pieces that were fine). Each entry in the returned lists is the
     *  file's full, absolute on-disk path (this.backup.targetPath + its relative path within the recovery),
     *  never just a bare file name. A file with no stored hash at all (an old cold storage metadata JSON, or
     *  the "None" integrity option was used at backup time) reports under `noData` - NOT a failure.
     *  @return undefined (nothing to show) if nothing selected carries any stored hash at all - callers should
     *  skip showing an integrity summary entirely for a recovery that simply never had hash data to check,
     *  rather than a summary that's all "no data". */
    private async verifyRecoveredFileIntegrity(): Promise<{ verified: string[], noData: string[], failed: string[] } | undefined> {
      // Built once as a Map (bare path -> hash) rather than a per-call Array.find() scan - a cold storage with
      // many discs/files otherwise makes this an O(files selected * files in cold storage) scan.
      // Keyed by where each file was backed up from - the path it is recovered to (see backedUpPath).
      const hashByBarePath = new Map<string, string>();
      this.coldStorageMetadataForAllOpticalDiscs.flat().forEach((e) => {
        if (e.stats.sha256 && !isOriginalNamesList(e)) { hashByBarePath.set(backedUpPath(e).replace(OPTICAL_DRIVE_LETTER_CONVENTION, ''), e.stats.sha256); }
      });

      let target = this.backup.targetPath;
      if (target[target.length - 1] != '\\') { target += '\\'; }

      const filesToHash: Array<{ absolutePath: string, expectedSha256: string }> = [];
      const noData: string[] = [];
      (this.selectedFilePathsWithExtraInfo || []).forEach((entry) => {
        const absolutePath = target + entry.path;
        const expected = hashByBarePath.get(entry.path);
        if (expected) {
          filesToHash.push({ absolutePath, expectedSha256: expected });
        } else {
          noData.push(absolutePath);
        }
      });

      if (filesToHash.length === 0) {
        return undefined;
      }

      const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
      loadingDialogRef.componentInstance.showCancelButton = false;
      loadingDialogRef.componentInstance.message = "Verifying SHA-256 hashes";      let results: Array<{ path: string, sha256: string, matched?: boolean }> = [];
      // Shows just a real percentage (not the accumulating `lines` scrolling list, which reserves a fixed 220px
      // box regardless of content) - see attachSha256HashesToDiscFiles's identical pattern in
      // backup-to-optical-media.component.ts.
      let hashedCount = 0;
      const listener = ipc.onResponseFromWorker((event, response) => {
        this.ngZone.run(() => {
          if (response.key === 'verify-file-hashes' && response.status === 'running') {
            const newLines = response.res as string[];
            hashedCount += newLines.length;
            loadingDialogRef.componentInstance.percent = Math.round((hashedCount / filesToHash.length) * 100);
          }
        });
      });
      try {
        results = (await ipc.verifyFileHashes(filesToHash)).res;
      } catch (error) {
        // A per-file read/hash problem is already caught inside verifyFileHashes itself (worker.ts) and comes
        // back as a normal FAILED result, not a rejection here - so a rejection reaching this catch is a
        // worker/IPC-level problem (e.g. a queueing error), not a finding about any specific file. The actual
        // recovered files already copied successfully by this point (this only runs after every disc's copy
        // completed) - only the OPTIONAL verification step itself couldn't run - so this must not be left to
        // propagate as an unhandled rejection: without this, the caller (finishRecoveryAfterOptionalMerge) would
        // never show ANY final dialog at all, leaving a successful recovery looking like the app hung. Tell the
        // user integrity verification itself couldn't run, then fall through as if there was nothing to check
        // (undefined) - the recovery itself still gets its normal "Data recovery successful" dialog afterward.
        listener.removeListener();
        loadingDialogRef.close();
        await new Promise<void>((resolve) => {
          const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
          errorDialog.disableClose = true;
          errorDialog.componentInstance.title = "Integrity verification could not run";
          errorDialog.componentInstance.message = `Your files were recovered successfully, but the SHA-256 integrity check itself could not complete: ${error}`;
          errorDialog.componentInstance.actionsNum = 1;
          errorDialog.componentInstance.action1Label = "Ok";
          errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); resolve(); };
        });
        return undefined;
      }
      listener.removeListener();
      loadingDialogRef.close();

      const verified: string[] = [];
      const failed: string[] = [];
      results.forEach((r) => {
        (r.matched ? verified : failed).push(r.path);
      });

      return { verified, noData, failed };
    }

    /** Detects groups of selected partial files (fileName.ext.part.001, fileName.ext.part.002, ...) and, if any
     *  are found, asks the user ONCE whether to reassemble all of them - not once per large file. Merging itself
     *  still has to happen one group at a time (each is a separate 7-Zip call), but that runs silently behind a
     *  single "please wait" dialog, and the outcome for every group is reported together in one summary dialog
     *  afterwards, rather than a dialog per file. */
    private async offerToMergeAnyPartialFiles(): Promise<void> {
      const partFileGroups = this.groupSelectedPartialFiles();
      if (partFileGroups.length === 0) {
        return;
      }

      const userWantsToMerge = await this.askUserToMergeAllPartialFileGroups(partFileGroups);
      if (!userWantsToMerge) {
        // The user chose to leave every partial file group as-is - tell them how to reassemble each by hand later.
        await this.showManualReassemblyInstructions(partFileGroups);
        return;
      }

      const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
      loadingDialogRef.componentInstance.showCancelButton = false;
      loadingDialogRef.componentInstance.message = "Reassembling split files";

      const results: Array<{ group: { originalFileName: string; partFilePaths: string[] }, merged: boolean, message: string }> = [];
      for (const group of partFileGroups) {
        results.push(await this.mergePartialFileGroupSilently(group));
      }
      loadingDialogRef.close();

      await this.showMergeSummary(results);

      const failedGroups = results.filter(r => !r.merged).map(r => r.group);
      if (failedGroups.length > 0) {
        // The app's own attempt failed for these - make sure the user still has a way forward.
        await this.showManualReassemblyInstructions(failedGroups);
      }
    }

    /** Groups the recovered/selected file paths (this.selectedFilePathsWithExtraInfo) by the large file they
     *  are a partial of. Only paths matching the "<name>.part.<digits>" convention used when splitting large
     *  files (see partitionBackupToOpticalMedia in worker.ts) are considered, and only groups of 2 or more are
     *  returned - a lone ".part.001" with no siblings selected is not a usable set to reassemble from anyway,
     *  and mergeFileParts itself also refuses fewer than 2 parts as a second line of defense.
     *  Each part's path is resolved to its actual absolute on-disk location using the exact same rule
     *  createTree/insertBranch (worker.ts) use to build the copy destination: this.backup.targetPath, with a
     *  trailing '\' appended if missing, followed by the file's path relative to the backup root - so this
     *  must be kept in sync with that logic if it ever changes. */
    private groupSelectedPartialFiles(): Array<{ originalFileName: string; partFilePaths: string[] }> {
      const partFilePattern = /^(.+)\.part\.\d+$/i;
      const groups = new Map<string, { originalFileName: string; partFilePaths: string[] }>();

      let target = this.backup.targetPath;
      if (target[target.length - 1] != '\\') { target += '\\'; }

      (this.selectedFilePathsWithExtraInfo || []).forEach((entry) => {
        const lastSlash = entry.path.lastIndexOf('\\');
        const dir = lastSlash >= 0 ? entry.path.substring(0, lastSlash + 1) : '';
        const fileName = lastSlash >= 0 ? entry.path.substring(lastSlash + 1) : entry.path;
        const match = partFilePattern.exec(fileName);
        if (match) {
          const originalFileName = match[1];
          const key = dir + originalFileName;
          if (!groups.has(key)) {
            groups.set(key, { originalFileName: originalFileName, partFilePaths: [] });
          }
          groups.get(key)!.partFilePaths.push(target + entry.path);
        }
      });

      return Array.from(groups.values()).filter(g => g.partFilePaths.length > 1);
    }

    /** The folder a group's parts were recovered into, ending in a backslash - which is also where
     *  mergeFileParts (worker.ts) writes the reassembled file. */
    private partFilesFolder(group: { partFilePaths: string[] }): string {
      const firstPart = group.partFilePaths[0];
      return firstPart.substring(0, firstPart.lastIndexOf('\\') + 1);
    }

    /** The full path the reassembled file of `group` gets (see partFilesFolder). */
    private reassembledFilePath(group: { originalFileName: string; partFilePaths: string[] }): string {
      return this.partFilesFolder(group) + group.originalFileName;
    }

    /** Shows ONE confirmation dialog covering every detected partial-file group at once, listing the full path
     *  each large file would be reassembled to (a scrollable list - there can be many), and asks whether to
     *  reassemble all of them. Resolves to true/false depending on the user's choice. Does not touch the
     *  filesystem. */
    private askUserToMergeAllPartialFileGroups(groups: Array<{ originalFileName: string; partFilePaths: string[] }>): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const confirmDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '700px'});
        confirmDialog.disableClose = true;
        confirmDialog.componentInstance.title = "Partial files detected";
        confirmDialog.componentInstance.message = groups.length === 1
          ? `It seems like you selected a set of partial files (.part.001 etc.) of a large file which did not fit ` +
            `on a single optical disc. Do you want to reassemble the original file from its parts?`
          : `It seems like you selected sets of partial files (.part.001 etc.) of ${groups.length} large files which ` +
            `did not fit on a single optical disc. Do you want to reassemble all of them from their parts?`;
        confirmDialog.componentInstance.lists = [{
          label: `To be reassembled (${groups.length}):`,
          items: groups.map(g => `${this.reassembledFilePath(g)}  (${g.partFilePaths.length} parts)`)
        }];
        confirmDialog.componentInstance.actionsNum = 2;
        confirmDialog.componentInstance.action1Label = groups.length === 1 ? "Yes, reassemble" : "Yes, reassemble all";
        confirmDialog.componentInstance.action2Label = "No, leave them as they are";
        confirmDialog.componentInstance.action1Callback = () => {
          confirmDialog.close();
          resolve(true);
        }
        confirmDialog.componentInstance.action2Callback = () => {
          confirmDialog.close();
          resolve(false);
        }
      });
    }

    /** Runs the actual reassembly for one confirmed group via the worker (mergeFileParts in worker.ts, which
     *  uses 7-Zip), and returns the outcome instead of reporting it itself - the caller batches every group's
     *  outcome into one summary dialog rather than showing one per file. The worker only deletes the partial
     *  files after it has positively verified the reassembly succeeded (integrity test, then extraction, then
     *  verifying the reassembled file exists and is non-empty) - if it did not succeed, nothing on disk is
     *  deleted for that group. */
    private async mergePartialFileGroupSilently(group: { originalFileName: string; partFilePaths: string[] }):
        Promise<{ group: { originalFileName: string; partFilePaths: string[] }, merged: boolean, message: string }> {
      let merged = false;
      let message = 'An unexpected error occurred.';
      try {
        const response = await ipc.mergeFileParts(group.partFilePaths, group.originalFileName);
        merged = response.res.merged;
        message = response.res.message;
      } catch (error) {
        message = `An unexpected error occurred while trying to reassemble "${group.originalFileName}": ` +
          (error && (error as any).message ? (error as any).message : JSON.stringify(error));
      }
      return { group, merged, message };
    }

    /** Shows ONE dialog summarizing the outcome of every attempted reassembly, instead of a dialog per file: the
     *  full path of every reassembled file, and of every one that failed (with the reason), each as a scrollable
     *  list - there can be many. */
    private showMergeSummary(results: Array<{ group: { originalFileName: string; partFilePaths: string[] }, merged: boolean, message: string }>): Promise<void> {
      return new Promise<void>((resolve) => {
        const allSucceeded = results.every(r => r.merged);
        const reassembled = results.filter(r => r.merged).map(r => this.reassembledFilePath(r.group));
        // One line per file - the reason's own line breaks (a 7-Zip error can span several) are flattened.
        const failed = results.filter(r => !r.merged).map(r => `${this.reassembledFilePath(r.group)}  -  ${r.message.replace(/\s+/g, ' ').trim()}`);

        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '700px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = allSucceeded ? "Reassembly successful" : "Reassembly finished with some failures";
        infoDialog.componentInstance.message = allSucceeded
          ? `Every file was reassembled, and the partial files it was reassembled from have been deleted.`
          : `Not every file could be reassembled. The partial files of the ones that failed were left untouched; ` +
            `the partial files of the ones that were reassembled have been deleted. The recovery process will continue.`;
        infoDialog.componentInstance.lists = [
          failed.length ? { label: `FAILED (${failed.length}):`, items: failed } : undefined,
          reassembled.length ? { label: `Reassembled (${reassembled.length}):`, items: reassembled } : undefined,
        ].filter((s): s is { label: string, items: string[] } => !!s);
        infoDialog.componentInstance.actionsNum = 1;
        infoDialog.componentInstance.action1Label = "Ok";
        infoDialog.componentInstance.action1Callback = () => {
          infoDialog.close();
          resolve();
        }
      });
    }

    /** ONE follow-up informational dialog explaining that the .part.NNN files are 7-Zip archive volumes (not
     *  raw file fragments, so they cannot just be concatenated together), with a copy-pasteable command per
     *  file to reassemble it by hand using 7-Zip directly, as a scrollable list (there can be many) with full
     *  paths. Covers every group passed in at once, rather than showing one dialog per file. Shown whenever the
     *  app either did not attempt, or was unable to complete, the automatic merge for one or more groups. */
    private showManualReassemblyInstructions(groups: Array<{ originalFileName: string; partFilePaths: string[] }>): Promise<void> {
      return new Promise<void>((resolve) => {
        const commands = groups.map((g) => {
          const firstPart = g.partFilePaths.slice().sort()[0];
          // -o: without it 7-Zip extracts into whatever folder the command is run from, not next to the parts.
          // Quoted without its trailing backslash (a '\"' could be read as an escaped quote) - except a drive root,
          // which needs that backslash and has no spaces, so it goes unquoted.
          const folder = this.partFilesFolder(g);
          const outputSwitch = /^[A-Za-z]:\\$/.test(folder) ? `-o${folder}` : `-o"${folder.replace(/\\$/, '')}"`;
          return `7z x ${outputSwitch} "${firstPart}"`;
        });

        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '700px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = "How to reassemble manually";
        infoDialog.componentInstance.message =
          `The .part.NNN files were created using 7-Zip's volume-splitting feature (the same ` +
          `"7z -v500m -mx0 a ..." command used when the backup was originally split). They are 7-Zip archive ` +
          `volumes, not raw file fragments, so simply concatenating them together will not work - you need ` +
          `7-Zip itself. To reassemble each file yourself, run its command below (using the 7-Zip executable ` +
          `configured in appData\\config.json) - 7-Zip finds the other part files (.002, .003, ...) next to the ` +
          `first one and writes the original file into the same folder.`;
        infoDialog.componentInstance.lists = [{ label: `Commands, one per file (${commands.length}):`, items: commands }];
        infoDialog.componentInstance.actionsNum = 1;
        infoDialog.componentInstance.action1Label = "Ok";
        infoDialog.componentInstance.action1Callback = () => {
          infoDialog.close();
          resolve();
        }
      });
    }


    selectAllFiles(selected: boolean){
      // Keep the "Select all" checkbox's own [checked] binding (allFilesSelected) in sync with what this
      // actually did to the tree - previously this only ever got set once, at field declaration (`= true`),
      // and never updated here, so the checkbox visually stayed checked even after createFilesTreeForReconstructedBackupPaths
      // called selectAllFiles(false) to start with nothing selected. That made the FIRST real click toggle it
      // to unchecked (a no-op, since nothing was selected to begin with) - selectAllNodes() only ever ran on
      // the second click, once the checkbox's displayed state finally caught up to true.
      this.allFilesSelected = selected;
      if(selected){
        this.filesTreeRef.selectAllNodes();
      }else{
        this.filesTreeRef.deselectAllNodes();
      }
    }

    goToHomePage(){
      goToMainMenuAndReload(this.router);
    }

  }