import { Component, numberAttribute, OnInit, ViewChild, ViewEncapsulation } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Router, ActivatedRoute } from '@angular/router';
import { BackupService } from '../core/services/backup/backup.service'
import { LoadingDialogComponent } from '../shared/components';
import { ConfirmationDialogComponent } from '../shared/components';
import { FormControl } from '@angular/forms';
import { WorkerCommunicator as ipc } from '../../../app/workers/worker-communicator'


@Component({
  selector: 'incremental-entry-point',
  templateUrl: './incremental-entry-point.component.html',
  styleUrls: ['./incremental-entry-point.component.scss'],
  encapsulation: ViewEncapsulation.None,
})
export class IncrementalEntryPointComponent implements OnInit {

  constructor(private router: Router, private route: ActivatedRoute, public backup: BackupService, public dialog: MatDialog) { }

  public incremental_help_msg = `
  This option: 
  \n1) Copies to the backup all the files that exist only on your source directory and not in the backup.
  \n2) Rewrites to the backup all the files that have been modified.
  \nThis option can only add or modify existing files in the backup.
  \nIt will not delete any files from the backup if they have been deleted from your source directory.`;
  
  public sync_help_msg = `This option synchronizes the backup with the files on your source directory.
  This means that in the end, the backup will have become the same as the source directory.
  Therefore, if a file has been deleted from the source directory, it will also be deleted from the backup directory, if it exists.`

  optical_media_choices: {value: string, viewValue: string, capacity: number}[] = [
    {value: 'cd', viewValue: 'CD (700 MB)', capacity: 0.7e9},
    {value: 'dvd', viewValue: 'DVD (4.7 GB)', capacity: 4.7e9},
    {value: 'blu-ray', viewValue: 'Blu ray (25 GB)', capacity: 25e9},
    {value: 'blu-ray', viewValue: 'Blu ray (50 GB)', capacity: 50e9},
    {value: 'blu-ray', viewValue: 'Blu ray (100 GB)', capacity: 100e9}
  ];

  selected_optical_medium!: {value: string, viewValue: string, capacity: number};

  // 0 is the first tab and 1 the next
  selected_tab!:FormControl;

  ngOnInit(): void {
    this.selected_tab = new FormControl(this.backup.selectedTabIndex);
   } 

  tabSelectionChanged(idx: number) {
    // When the user changes the tab clear all inputs.
    this.backup.sourcePath = "";
    this.backup.targetPath = "";
    this.backup.selectedTabIndex = idx;
  }

  goToMainMenu(){
    this.router.navigate(['main-menu']);
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

  getSource():void{
    this.chooseDirectory().then((path)=>{
      if(path != undefined){
        this.backup.sourcePath = path;
        console.log(path)
      }
    });
  }

  getTarget():void{
    this.chooseDirectory().then((path)=>{
      if(path != undefined){
        this.backup.targetPath = path;
        console.log(path)
      }
    });
  }

  UpdateBackupProceed():void{
    let url!: string;
    
    switch (this.backup.mode.value) {
      case 'incremental':
        url = 'incremental';
        break;
      case 'sync':
        // Sync Dirs is a real, implemented feature (see sync-dirs.component.ts) - this used to show a stale
        // "not implemented yet" dialog and navigate straight to 'sync-dirs' unconditionally, bypassing the
        // sourcePath/targetPath check below entirely, then ALSO navigate to a non-existent 'sync' route right
        // after if paths were set (racing/cancelling the first navigation). Now it goes through the exact same
        // path-validation and navigation as every other mode.
        url = 'sync-dirs';
        break;
    }

    if (this.backup.sourcePath && this.backup.targetPath) {
      this.router.navigate([url]);
    }else{
      const loadingDialogRef = this.dialog.open(ConfirmationDialogComponent, {maxWidth: '450px'});
      loadingDialogRef.componentInstance.title = "Paths selection";
      if(this.backup.sourcePath){
        loadingDialogRef.componentInstance.message = `You have not selected the backup location`;
      }else if(this.backup.targetPath){
        loadingDialogRef.componentInstance.message = `You have not selected the source location`;
      }else{
        loadingDialogRef.componentInstance.message = `You have not selected the source location and backup location`;
      }
    }

  }

 

}

