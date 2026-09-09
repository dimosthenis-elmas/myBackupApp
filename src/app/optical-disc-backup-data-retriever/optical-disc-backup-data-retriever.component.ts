import { Component, Input, NgZone, OnDestroy, OnInit, ViewChild, ElementRef } from '@angular/core';
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
 
  @Component({
    selector: 'optical-disc-backup-data-retriever',
    templateUrl: './optical-disc-backup-data-retriever.html',
    styleUrls: ['./optical-disc-backup-data-retriever.scss'],
    providers: []
  })
  export class OpticalDiscBackupDataRetriever implements OnInit, OnDestroy{  

    step:string = 'step_1';
    allFilesSelected:boolean = true;
    /** Forwarded straight through to this component's own <files-tree> (see that component for the mechanics) -
     *  this component itself has no opinion on the default; the specific screen embedding it decides (see
     *  recover-data-from-optical-media.component.ts, the only caller that ever reaches step_3 - the file
     *  SELECTION step - at all: add-missing-files-to-optical-media-cold-storage.component.ts also embeds this
     *  component, but only ever drives it through step_2's disc-enumeration, via
     *  getCombinedFilePathsFromAllOpticalDiscs() alone, never createFilesTreeForReconstructedBackupPaths() - so
     *  step_3, and this input, is simply never reached in that context). */
    @Input() groupPartialFiles: boolean = true;
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
     * discs producing the same disc id (an empty disc, or the same disc listed twice), which would otherwise silently
     * misattribute files to the wrong disc later on, since opticalDiskIds.indexOf(id) is used to label discs to the user.
     */
    seedFromExternalMetadata(metadata: ColdStorageMetadata): boolean {
      let opticalDiskIds: number[] = [];
      let completeBackupFilePaths: string[] = [];
      let discIdsForCompleteBackupFilePaths: number[] = [];

      metadata.forEach((discFiles) => {
        let filePaths = discFiles.map(f => f.path).sort();
        let currentDiskId = this.getStringHash(filePaths.toString());

        opticalDiskIds.push(currentDiskId);
        completeBackupFilePaths = completeBackupFilePaths.concat(filePaths);
        discIdsForCompleteBackupFilePaths = discIdsForCompleteBackupFilePaths.concat(
          Array(discFiles.length).fill(currentDiskId)
        );
      });

      if(new Set(opticalDiskIds).size !== opticalDiskIds.length){
        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = `Error`;
        infoDialog.componentInstance.message = `The provided cold storage metadata JSON looks malformed: two or more discs produce
          the same identifier (for example, an empty disc, or the same disc listed twice). Please check the JSON file and try again.`;
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

        // File paths with stats is going to be used in case the user requests the contents of the entire multi optical disc cold storage via
        // the promise getCombinedFilePathsFromAllOpticalDiscs.
        // Normally the user will then use the stats to check if any of the files present in the cold storage has been modified in the master.
        // In such a case, the cold storage is out of spec and must be recreated from scratch again.
        // If the user just wants to recover the data in a cold storage (set of optical discs) we only need the file paths and not the stats (modified date, size etc).
        // Thus we keep both  filePathsWithStats and filePaths (created from filePathsWithStats by reducing), and use them accordingly.
        let filePathsWithStats: Array<{
          "path": string;
          "stats": {
              "size": number;
              "mtime": Date;
              "isDirectory": boolean;
          };
        }> = (await ipc.getFilePathsWithStats(mountedVolumeLetter)).res
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

        if(this.stringArrayHasDuplicates(this.completeBackupFilePaths.concat(filePaths))){
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
          this.completeBackupFilePaths = this.completeBackupFilePaths.concat(filePaths);
          this.coldStorageMetadataForAllOpticalDiscs = this.coldStorageMetadataForAllOpticalDiscs.concat([filePathsWithStats]);
        
          this.discIdsForCompleteBackupFilePaths = this.discIdsForCompleteBackupFilePaths.concat(Array(filePaths.length).fill(currentDiskId))

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

      await this.filesTreeRef.setTreeData(sortedCompleteBackupFilePaths, sortedDiscIdsForCompleteBackupFilePaths);
      this.selectAllFiles(false);
      this.filesTreeRef.expandAllNodes();
      this.filesTreeNotLoaded  = false;
    }

    getPathsOfFilesToBeRecovered(){
      this.selectedFilePathsWithExtraInfo = this.filesTreeRef.getSelectedFilePathsIncludingExtraInfo();
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
      ipc.stop();

      this.step='step_5';
      this.opticalMediumLoaded = false;
      this.showLogs=false;

      // Wait for optical disk to be loaded.
      let response = await ipc.waitForOpticalDiskToBeMounted();
      this.mountedVolumeLetter = response.res._mounted;
      this.opticalMediumLoaded=true;

      //Get the id of the disc inserted
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
          this.dialogClosed=false;
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
                // Print the response to the scrollable list logs.
                this.backup.previewLogsStream.next(response.res);
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
              console.error('Got unknown message from ipcMain: ');
              console.error(response);
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

      

      // Send request to worker to copy the selected files to target.
      this.showLogs=true;
      try {
        this.copyingPromise = ipc.incrementalCopyFiles(selectedPathsPresentInTheInsertedDisk, this.mountedVolumeLetter, this.backup.targetPath);
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
      }

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
          ? `The recovery finished, but SHA-256 integrity verification found one or more problems - see the list(s) below.`
          : `The recovery of your data has been completed successfully, and SHA-256 integrity verification confirmed every file with recorded hash data matches.`;
        // Full lists, not a truncated "first 15, and N more" string - see ConfirmationDialogComponent's own
        // `lists` field: each renders as a real virtualized scrolling list, so however many files are in a
        // given category, only the ones actually visible are ever real DOM nodes. Only non-empty sections are
        // included (an empty `items` array is never shown, per that field's own contract).
        infoDialog.componentInstance.lists = [
          integrity.failed.length ? { label: `FAILED integrity check (${integrity.failed.length}) - this can mean real data corruption (a bad drive read, disc handling damage):`, items: integrity.failed } : undefined,
          integrity.verified.length ? { label: `Verified (${integrity.verified.length}):`, items: integrity.verified } : undefined,
          integrity.noData.length ? { label: `No integrity data available, not checked (${integrity.noData.length}):`, items: integrity.noData } : undefined,
        ].filter((s): s is { label: string, items: string[] } => !!s);
      }
      infoDialog.componentInstance.message = message;
      infoDialog.componentInstance.actionsNum = 1;
      infoDialog.componentInstance.action1Label = "Ok";
      infoDialog.componentInstance.action1Callback = () => {
          infoDialog.close();
          this.finishedCopyingFiles = true;
          this.recoveredAllFilesFromAllDiscs = true;
        }
    }

    /** Runs SHA-256 integrity verification (see verifyFileHashes in worker.ts) over every recovered file that
     *  has a stored hash. Grouped by LOGICAL file - reuses the same .partNNN grouping groupSelectedPartialFiles
     *  already uses for the merge offer, so a large file split across several pieces reports as ONE line: it is
     *  "verified" only if every one of its constituent pieces that HAD a stored hash actually matched, and
     *  "FAILED" if any did not. An ordinary (non-split) file is just its own one-piece group. A group where NONE
     *  of its pieces carry a stored hash at all (an old cold storage metadata JSON, or the "None" integrity
     *  option was used at backup time) reports as "no integrity data available" - NOT a failure.
     *  @return undefined (nothing to show) if nothing selected carries any stored hash at all - callers should
     *  skip showing an integrity summary entirely for a recovery that simply never had hash data to check,
     *  rather than a summary that's all "no data". */
    private async verifyRecoveredFileIntegrity(): Promise<{ verified: string[], noData: string[], failed: string[] } | undefined> {
      // Built once as a Map (bare path -> hash) rather than a per-call Array.find() scan - a cold storage with
      // many discs/files otherwise makes this an O(files selected * files in cold storage) scan, done twice
      // over (once building filesToHash, once tallying results below).
      const hashByBarePath = new Map<string, string>();
      this.coldStorageMetadataForAllOpticalDiscs.flat().forEach((e) => {
        if (e.stats.sha256) { hashByBarePath.set(e.path.replace(OPTICAL_DRIVE_LETTER_CONVENTION, ''), e.stats.sha256); }
      });
      const findExpectedHash = (barePath: string): string | undefined => hashByBarePath.get(barePath);

      let target = this.backup.targetPath;
      if (target[target.length - 1] != '\\') { target += '\\'; }

      const partFilePattern = /^(.+)\.part\.\d+$/i;
      const groups = new Map<string, { label: string, barePaths: string[] }>();
      (this.selectedFilePathsWithExtraInfo || []).forEach((entry) => {
        const lastSlash = entry.path.lastIndexOf('\\');
        const dir = lastSlash >= 0 ? entry.path.substring(0, lastSlash + 1) : '';
        const fileName = lastSlash >= 0 ? entry.path.substring(lastSlash + 1) : entry.path;
        const match = partFilePattern.exec(fileName);
        const label = match ? dir + match[1] : entry.path;
        if (!groups.has(label)) { groups.set(label, { label, barePaths: [] }); }
        groups.get(label)!.barePaths.push(entry.path);
      });

      const filesToHash: Array<{ absolutePath: string, expectedSha256: string }> = [];
      const groupHasAnyHash = new Map<string, boolean>();
      groups.forEach((group) => {
        let anyHash = false;
        group.barePaths.forEach((barePath) => {
          const expected = findExpectedHash(barePath);
          if (expected) {
            anyHash = true;
            filesToHash.push({ absolutePath: target + barePath, expectedSha256: expected });
          }
        });
        groupHasAnyHash.set(group.label, anyHash);
      });

      if (filesToHash.length === 0) {
        return undefined;
      }

      const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
      loadingDialogRef.componentInstance.showCancelButton = false;
      loadingDialogRef.componentInstance.message = "Verifying SHA-256 hashes";
      loadingDialogRef.componentInstance.lines = [];
      let results: Array<{ path: string, sha256: string, matched?: boolean }> = [];
      const listener = ipc.onResponseFromWorker((event, response) => {
        this.ngZone.run(() => {
          if (response.key === 'verify-file-hashes' && response.status === 'running') {
            loadingDialogRef.componentInstance.pushLines(response.res as string[]);
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

      const matchedByAbsolutePath = new Map<string, boolean>(results.map(r => [r.path, !!r.matched]));

      const verified: string[] = [];
      const noData: string[] = [];
      const failed: string[] = [];
      groups.forEach((group) => {
        if (!groupHasAnyHash.get(group.label)) {
          noData.push(group.label);
          return;
        }
        const everyHashedPieceMatched = group.barePaths.every((barePath) => {
          const expected = findExpectedHash(barePath);
          return !expected || matchedByAbsolutePath.get(target + barePath) === true;
        });
        (everyHashedPieceMatched ? verified : failed).push(group.label);
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

    /** Shows ONE confirmation dialog covering every detected partial-file group at once, listing each large
     *  file by name, and asks whether to reassemble all of them. Resolves to true/false depending on the
     *  user's choice. Does not touch the filesystem. */
    private askUserToMergeAllPartialFileGroups(groups: Array<{ originalFileName: string; partFilePaths: string[] }>): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const names = groups.map(g => `"${g.originalFileName}"`).join(', ');
        const confirmDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '550px'});
        confirmDialog.disableClose = true;
        confirmDialog.componentInstance.title = "Partial files detected";
        confirmDialog.componentInstance.message = groups.length === 1
          ? `It seems like you selected a set of partial files (.part001 etc.) for ${names}. These files are ` +
            `parts of a large single file which did not fit to a single optical disc. Do you want to ` +
            `reassemble the original file from the partials?`
          : `It seems like you selected sets of partial files (.part001 etc.) for the following large files: ` +
            `${names}. These files are parts of large files which did not fit to a single optical disc. Do ` +
            `you want to reassemble all of them from their partials?`;
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

    /** Shows ONE dialog summarizing the outcome of every attempted reassembly, instead of a dialog per file.
     *  Each entry is a short, self-contained "N) file: outcome" sentence rather than relying on line breaks for
     *  structure, since the dialog does not preserve them. */
    private showMergeSummary(results: Array<{ group: { originalFileName: string; partFilePaths: string[] }, merged: boolean, message: string }>): Promise<void> {
      return new Promise<void>((resolve) => {
        const allSucceeded = results.every(r => r.merged);
        const lines = results.map((r, idx) =>
          `${idx + 1}) "${r.group.originalFileName}": ${r.merged ? 'reassembled successfully.' : 'FAILED - ' + r.message}`
        );

        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '600px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = allSucceeded ? "Reassembly successful" : "Reassembly finished with some failures";
        infoDialog.componentInstance.message = `Reassembly results: ${lines.join('  ')} ` +
          (allSucceeded
            ? 'The partial files that were successfully reassembled have been deleted.'
            : 'Any partial files that could not be reassembled were left untouched. The recovery process will continue.');
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
     *  file to reassemble it by hand using 7-Zip directly. Covers every group passed in at once, rather than
     *  showing one dialog per file. Shown whenever the app either did not attempt, or was unable to complete,
     *  the automatic merge for one or more groups. */
    private showManualReassemblyInstructions(groups: Array<{ originalFileName: string; partFilePaths: string[] }>): Promise<void> {
      return new Promise<void>((resolve) => {
        const commands = groups.map((g, idx) => {
          const sortedParts = g.partFilePaths.slice().sort();
          return `${idx + 1}) "${g.originalFileName}":  7z x "${sortedParts[0]}"`;
        }).join('  ');

        const infoDialog = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '600px'});
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = "How to reassemble manually";
        infoDialog.componentInstance.message =
          `The .part.NNN files below were created using 7-Zip's volume-splitting feature (the same ` +
          `"7z -v500m -mx0 a ..." command used when the backup was originally split). They are 7-Zip archive ` +
          `volumes, not raw file fragments, so simply concatenating them together will not work - you need ` +
          `7-Zip itself. To reassemble each file yourself, run the corresponding command below (using the ` +
          `7-Zip executable configured in appData\\config.json) - 7-Zip will automatically find the other ` +
          `part files (.002, .003, ...) alongside it and reconstruct the original file in the same folder. ` +
          `${commands}`;
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