import { Component, numberAttribute, ViewChild, ViewEncapsulation } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Router, ActivatedRoute } from '@angular/router';
import { BackupService } from '../core/services/backup/backup.service'
import { LoadingDialogComponent } from '../shared/components';
import { ConfirmationDialogComponent } from '../shared/components';
import { WorkerCommunicator as ipc } from '../../../app/workers/worker-communicator'


@Component({
  selector: 'incremental-entry-point',
  templateUrl: './incremental-entry-point.component.html',
  styleUrls: ['./incremental-entry-point.component.scss'],
  encapsulation: ViewEncapsulation.None,
})
export class IncrementalEntryPointComponent {

  constructor(private router: Router, private route: ActivatedRoute, public backup: BackupService, public dialog: MatDialog) { }

  public incremental_help_msg = `
  This option:
  \n1) Copies to the backup all the files that exist only on your source directory and not in the backup.
  \n2) Rewrites to the backup all the files that have been modified.
  \nThis option can only add or modify existing files in the backup.
  \nIt will not delete any files from the backup if they have been deleted from your source directory.`;

  optical_media_choices: {value: string, viewValue: string, capacity: number}[] = [
    {value: 'cd', viewValue: 'CD (700 MB)', capacity: 0.7e9},
    {value: 'dvd', viewValue: 'DVD (4.7 GB)', capacity: 4.7e9},
    {value: 'blu-ray-25', viewValue: 'Blu ray (25 GB)', capacity: 25e9},
    {value: 'blu-ray-50', viewValue: 'Blu ray (50 GB)', capacity: 50e9},
    {value: 'blu-ray-100', viewValue: 'Blu ray (100 GB)', capacity: 100e9}
  ];

  selected_optical_medium!: {value: string, viewValue: string, capacity: number};

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
    // This screen only ever drives the Incremental flow - "Synchronize directories" has its own dedicated
    // main-menu tile (main-menu.component.ts's goToSyncDirsPage()) that routes straight to 'sync-dirs',
    // bypassing this component entirely. There used to be a second, unreachable "sync" mode selected via a
    // BackupService.mode value nothing on this screen could actually set - removed along with that dead code.
    if (this.backup.sourcePath && this.backup.targetPath) {
      this.router.navigate(['incremental']);
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

