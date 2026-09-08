import { Component, NgZone, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { BackupService } from '../core/services/backup/backup.service';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';



@Component({
  selector: 'main-menu',
  templateUrl: './main-menu.component.html',
  styleUrl: './main-menu.component.scss'
})
export class MainMenuComponent implements OnInit{
    constructor(private router: Router, private route: ActivatedRoute, public backup: BackupService, public dialog: MatDialog, private snackBar: MatSnackBar) { }
  ngOnInit(): void {
  }

  /** The temp-dir-leftovers "Clear" snackbar (app.component.ts's clearTempDataDirectoryOnStartup) is meant to be
   *  a main-menu-only offer, not something that follows the user into a feature screen - MatSnackBar is a root-
   *  provided singleton, so dismiss() here reaches the exact same snackbar instance app.component.ts opened,
   *  with no reference-passing needed. Called synchronously, before router.navigate() - dismiss() starts the
   *  snackbar's own close animation immediately, so it's already on its way out before the new screen even
   *  starts loading, rather than lingering on top of it. */
  private goToFeature(path: string): void {
    this.snackBar.dismiss();
    this.router.navigate([path]);
  }

  goToIncrementalBackupPage(){
    this.goToFeature('incremental-entry-point');
  }

  goToSyncDirsPage(){
    this.goToFeature('sync-dirs');
  }

  goToBackupToOpticalMediaPage(){
    this.goToFeature('backup-to-optical-media');
  }

  goToRecoverDataFromOpticalMediaBackup(){
    this.goToFeature('recover-data-from-optical-media');
  }

  goToAddFilesToColdStorage(){
    this.goToFeature('add-missing-files-to-optical-media-cold-storage');
  }


}
