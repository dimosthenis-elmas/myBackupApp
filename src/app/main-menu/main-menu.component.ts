import { Component, NgZone, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { BackupService } from '../core/services/backup/backup.service';
import { MatDialog } from '@angular/material/dialog';



@Component({
  selector: 'main-menu',
  templateUrl: './main-menu.component.html',
  styleUrl: './main-menu.component.scss'
})
export class MainMenuComponent implements OnInit{
    constructor(private router: Router, private route: ActivatedRoute, public backup: BackupService, public dialog: MatDialog) { }
  ngOnInit(): void {
  }

  goToIncrementalBackupPage(){
    this.router.navigate(['incremental-entry-point']);
  }

  goToSyncDirsPage(){
    this.router.navigate(['sync-dirs']);
  }

  goToBackupToOpticalMediaPage(){
    this.router.navigate(['backup-to-optical-media']);
  }

  goToRecoverDataFromOpticalMediaBackup(){
    this.router.navigate(['recover-data-from-optical-media']);
  }

  goToAddFilesToColdStorage(){
    this.router.navigate(['add-missing-files-to-optical-media-cold-storage']);
  }


}
