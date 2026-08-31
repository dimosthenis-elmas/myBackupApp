import { Component, inject, NgZone, OnDestroy, OnInit, ViewChild, ViewChildren, QueryList, ElementRef, contentChild } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { FilesTreeModule } from '../files-tree/files-tree.module';
import { BackupService } from '../core/services/backup/backup.service';
import { IncrementalDialogComponent } from '../incremental-dialog/incremental-dialog.component';
import { ConfirmationDialogComponent } from '../shared/components/confirmation-dialog/confirmation-dialog.component';
import { LoadingDialogComponent } from '../shared/components/loading-dialog/loading-dialog.component';
import { Subject } from 'rxjs';
import { WorkerCommunicator as ipc } from '../../../app/workers/worker-communicator'
import { ColdStorageMetadata, WorkerListener, WorkerResponse } from '../../../app/workers/ipc.interfaces';
import { MatChip } from '@angular/material/chips';
import { MatChipSet } from '@angular/material/chips';
import {FormBuilder, Validators, FormsModule, ReactiveFormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatInputModule} from '@angular/material/input';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatStepperModule} from '@angular/material/stepper';
import {MatCheckboxModule} from '@angular/material/checkbox';
import { FilesTreeComponent } from '../files-tree/files-tree.component';
import { OpticalDiscBackupDataRetriever} from '../optical-disc-backup-data-retriever/optical-disc-backup-data-retriever.component';
import { create } from 'domain';
import { BlobOptions } from 'buffer';
import { ScrollableListComponent } from '../scrollable-list/scrollable-list.component';
import { compileSchema, JsonSchema, SchemaNode } from "json-schema-library";
const mySchema =require('../schemas/filesMetadata.schema.json');

@Component({
  selector: 'recover-data-from-optical-media',
  templateUrl: './recover-data-from-optical-media.component.html',
  styleUrl: './recover-data-from-optical-media.component.scss'
})
export class RecoverDataFromOpticalMediaComponent implements OnInit, OnDestroy{

  step='step_1';
  odbr_ref!: OpticalDiscBackupDataRetriever;
  externalMetadataJSONpath!:string;
  useExternalMetadata = false;
  json_coldStorageFilesMetadata!: ColdStorageMetadata;
  /** True from the moment a JSON file is picked (getJSON) until afterJSONpathIsGiven has actually finished
   *  reading + schema-validating it and (on success) populated json_coldStorageFilesMetadata. step1()'s own guard
   *  already checks json_coldStorageFilesMetadata rather than externalMetadataJSONpath, so this can't misroute
   *  into the wrong workflow the way add-missing-files-to-optical-media-cold-storage.component.ts's identical
   *  getJSON()/afterJSONpathIsGiven() once did (see that component's loadingExternalMetadataJSON for the full
   *  story) - but without this, clicking "Next" in the same narrow window still shows an incorrect "no valid JSON
   *  file has been selected yet" dialog for a JSON that WAS selected and is just still loading. Bound to the
   *  "Next" button's [disabled] in the template. */
  loadingExternalMetadataJSON = false;
  /** Passed down to <optical-disc-backup-data-retriever>'s own groupPartialFiles @Input (forwarded again from
   *  there to its internal <files-tree> - see FilesTreeComponent for the actual mechanics). Owned HERE, not by
   *  the retriever itself, because this is the only screen where the file-selection step (step_3, where the
   *  checkbox for this actually renders) is ever reached - see that @Input's own doc comment for why
   *  add-missing-files-to-optical-media-cold-storage.component.ts's embedding of the same retriever never gets
   *  there. Defaults to ON: selecting only SOME of a split file's parts isn't a real use case (the merge-offer
   *  the retriever runs after recovery would just fail on an incomplete set), so grouping them by default saves
   *  clicks for the common case, and a user who genuinely wants only some parts can still manually uncheck the
   *  ones they don't want afterward. */
  groupPartialFiles = true;

  constructor(public router: Router, private route: ActivatedRoute, public dialog: MatDialog, public backup: BackupService,
     private ngZone: NgZone, private eleRef: ElementRef) { }

  @ViewChild(OpticalDiscBackupDataRetriever)  set odbr(v: OpticalDiscBackupDataRetriever) {
    setTimeout(() => {
      this.odbr_ref = v;
    }, 0);
  }

  ngOnInit(): void {

  }

  ngAfterViewInit(): void {

  }

  ngOnDestroy(): void {

  }

  goToMainMenu(){
    
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

  async chooseDirectory (): Promise<string>{
    const dialogConfig = {
      title: 'Directory selection',
      buttonLabel: 'Select this directory',
      properties: ['openDirectory']
    };    
    const res = await window.electronAPI.openDialog('showOpenDialog', dialogConfig);
    return res.filePaths[0];
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


  getDirToCopyRecoveredData():void{
    this.chooseDirectory().then((path)=>{
      if(path != undefined){
        this.backup.targetPath = path;
      }
    });
  }

  step1(): void{
    // Second guard on top of the "Next" button's own [disabled]="loadingExternalMetadataJSON" - belt-and-braces
    // against anything else that might invoke step1() while a JSON is still being read/validated (see
    // loadingExternalMetadataJSON's own doc comment). Without this, the check below would otherwise show a
    // misleading "no valid JSON file has been selected yet" dialog for a JSON that WAS selected and is just
    // still loading.
    if(this.useExternalMetadata && this.loadingExternalMetadataJSON){
      return;
    }
    if(!this.backup.targetPath || (this.useExternalMetadata && !this.json_coldStorageFilesMetadata)){
      const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
      loadingDialogRef.componentInstance.title = "Paths selection";
      loadingDialogRef.componentInstance.message = !this.backup.targetPath
        ? `You have not selected the directory to restore the backup to.`
        : `You have chosen to provide the cold storage files metadata via a JSON file, but no valid JSON file has been selected yet.`;
    }else if(this.useExternalMetadata){
      /* Skip reading every disc one by one: seed directly from the already-loaded, schema-validated JSON, then jump
       straight to the files tree. The user will only be asked to insert the specific discs needed for the files
       they select (see recoverAllFilesFromAllDiscs / discIdsNeededForTheRecoveryOfSelectedFiles in
       optical-disc-backup-data-retriever.component.ts). If the metadata looks malformed, seedFromExternalMetadata
       already shows an explanatory dialog and returns false; we stay on step_1 so the user can pick another file. */
      if(this.odbr_ref.seedFromExternalMetadata(this.json_coldStorageFilesMetadata)){
        this.step = 'step_2'
        this.odbr_ref.createFilesTreeForReconstructedBackupPaths();
      }
    }else{
      this.step = 'step_2'
      this.odbr_ref.getCombinedFilePathsFromAllOpticalDiscs().then((x)=>{
        console.log(x);
        this.odbr_ref.createFilesTreeForReconstructedBackupPaths();
        /* After calling createFilesTreeForReconstructedBackupPaths the recovery process continues automatically.
         No need to call anything else. Not the most intuitive design, I know, might have to make it a bit more straightforward and
         self explanatory in a future version.*/
      });
    }
  }
  
}
