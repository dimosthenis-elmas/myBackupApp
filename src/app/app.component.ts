import { Component, OnInit } from '@angular/core';
import { ElectronService } from './core/services';
import { TranslateService } from '@ngx-translate/core';
import { APP_CONFIG } from '../environments/environment';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ConfirmationDialogComponent } from './shared/components/confirmation-dialog/confirmation-dialog.component';
import { LoadingDialogComponent } from './shared/components/loading-dialog/loading-dialog.component';
import { WorkerCommunicator as ipc } from '../../app/workers/worker-communicator';
import { goToMainMenuAndReload } from './shared/utils/go-to-main-menu';
import { ErrorReporterService } from './core/services/error-reporter/error-reporter.service';

interface StringIndexedObject {
  [key: string]: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})

export class AppComponent implements OnInit {
  headerTitles: StringIndexedObject = {
    "incremental-entry-point": "Cumulative backup",
    "incremental-copying": "Cumulative backup",
    "incremental": "Cumulative backup",
    "sync-dirs": "Synchronize directories",
    "backup-to-optical-media": "Backup to optical media",
    "recover-data-from-optical-media": "Recover data from optical media",
    "add-missing-files-to-optical-media-cold-storage": "Add missing files to optical media cold storage"
  };
  constructor(
    private electronService: ElectronService,
    private translate: TranslateService,
    public router: Router,
    private dialog: MatDialog,
    private snackBar: MatSnackBar,
    // Not otherwise referenced here - injecting it forces this root-provided singleton to construct now, at
    // startup, rather than lazily on first use elsewhere, so its error-dialog/IPC listener registration
    // (see ErrorReporterService's own comment) is in place as early as possible.
    private errorReporter: ErrorReporterService
  ) {


    this.translate.setDefaultLang('en');
    console.log('APP_CONFIG', APP_CONFIG);

    if (electronService.isElectron) {
      console.log(process.env);
      console.log('Run in electron');
      console.log('Electron ipcRenderer', this.electronService.ipcRenderer);
      console.log('NodeJS childProcess', this.electronService.childProcess);
    } else {
      console.log('Run in browser');
    }
  }

  async ngOnInit(): Promise<void> {
    if (this.electronService.isElectron) {
      // Config is checked first: the temp directory checks below depend on config.json too, so
      // fixing/acknowledging config problems before touching the temp directory avoids the checks stepping on
      // each other.
      await this.locateExecutables();

      const tempDirectoryIsUsable = await this.checkTempDataDirectoryOwnership();
      if (!tempDirectoryIsUsable) {
        // The app is being closed (see checkTempDataDirectoryOwnership) - nothing after this point should run.
        return;
      }

      await this.clearTempDataDirectoryOnStartup();
    }
  }

  /** On startup: config.json must point to the programs the optical-media features need - 7-Zip and ImgBurn. The
   *  worker looks for any that is not set, or no longer there, where it is usually installed, and saves what it
   *  finds (locateExecutables in worker.ts) - with no dialog. Only for a program it cannot find is the user asked
   *  (askWhereExecutableIs). Anything chosen is saved to config.json, merged in - nothing else in the file changes. */
  private async locateExecutables(): Promise<void> {
    let notFound: Array<{ key: string, program: string, fileName: string, purpose: string, usualFolder: string, website: string }>;
    try {
      notFound = (await ipc.locateExecutables()).res;
    } catch (error) {
      console.error('Could not look for 7-Zip and ImgBurn', error);
      return;
    }

    for (const executable of notFound) {
      const chosenPath = await this.askWhereExecutableIs(executable);
      if (!chosenPath) { continue; }
      let saved: { success: boolean; message: string };
      try {
        saved = (await ipc.updateConfig({ [executable.key]: chosenPath })).res;
      } catch (error) {
        saved = { success: false, message: String(error) };
      }
      if (!saved.success) {
        await new Promise<void>((resolve) => {
          const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
          errorDialog.disableClose = true;
          errorDialog.componentInstance.title = "Could not save configuration";
          errorDialog.componentInstance.message = saved.message;
          errorDialog.componentInstance.actionsNum = 1;
          errorDialog.componentInstance.action1Label = "Ok";
          errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); resolve(); };
        });
      }
    }
  }

  /** Tells the user that `executable` was not found and what the app needs it for, and offers to show the app where
   *  it is: "Choose <file>" opens a file chooser - cancelling it comes back to this dialog - and "Not now" leaves it
   *  unset, to be asked again at the next start (Cumulative backup and Synchronize directories work without it).
   *  Resolves to the chosen path, or undefined for "Not now". */
  private async askWhereExecutableIs(executable: { program: string, fileName: string, purpose: string, usualFolder: string, website: string }): Promise<string | undefined> {
    for (;;) {
      const choose = await new Promise<boolean>((resolve) => {
        const dialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        dialog.disableClose = true;
        dialog.componentInstance.title = `${executable.program} not found`;
        dialog.componentInstance.message =
          `${executable.program} is needed ${executable.purpose}, and was not found where it is usually installed.\n\n` +
          `If it is installed, click "Choose ${executable.fileName}" and select it (usually in ${executable.usualFolder}). ` +
          `If not, install it from ${executable.website} and restart the app.\n\n` +
          `With "Not now", Cumulative backup and Synchronize directories still work; the app asks again at its next start.`;
        // The second button is the focused one (Enter) - what the dialog recommends.
        dialog.componentInstance.actionsNum = 2;
        dialog.componentInstance.action1Label = "Not now";
        dialog.componentInstance.action1Callback = () => { dialog.close(); resolve(false); };
        dialog.componentInstance.action2Label = `Choose ${executable.fileName}`;
        dialog.componentInstance.action2Callback = () => { dialog.close(); resolve(true); };
      });
      if (!choose) { return undefined; }

      const res = await window.electronAPI.openDialog('showOpenDialog', {
        title: `Choose ${executable.fileName}`,
        buttonLabel: 'Choose',
        properties: ['openFile'],
        filters: [{ name: executable.fileName, extensions: ['exe'] }]
      });
      const chosenPath: string | undefined = (res.filePaths && res.filePaths.length > 0) ? res.filePaths[0] : undefined;
      if (!chosenPath) { continue; } // the file picker was cancelled - back to the dialog
      // Accept only the program file itself (7z.exe / ImgBurn.exe): a wrong pick (7zFM.exe, a portable launcher,
      // the installer) exists too, so it would otherwise be kept for good and every later use would fail.
      const chosenName = chosenPath.replace(/\\/g, '/').split('/').pop();
      if (chosenName && chosenName.toLowerCase() === executable.fileName.toLowerCase()) {
        return chosenPath;
      }
      await new Promise<void>((resolve) => {
        const dialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        dialog.disableClose = true;
        dialog.componentInstance.title = "Wrong file";
        dialog.componentInstance.message =
          `That is not ${executable.program}. Select the file named ${executable.fileName}.`;
        dialog.componentInstance.actionsNum = 1;
        dialog.componentInstance.action1Label = "Ok";
        dialog.componentInstance.action1Callback = () => { dialog.close(); resolve(); };
      });
    }
  }

  /** On startup, verifies the configured temp/cache directory (cacheDataDirectoryPath in config.json) both
   *  exists and was created by this app itself - see ensureTempDataDirectoryIsAppOwned in worker.ts for why
   *  that distinction matters: this directory's contents get deleted by the app (clearTempDataDirectory), and
   *  cacheDataDirectoryPath can be pointed at literally any path on disk, so the app must never treat a
   *  pre-existing directory - which could already hold real content, even something as significant as the
   *  user's Documents folder if misconfigured - as safe to write into or ever clear.
   *
   *  If the directory does not exist yet, the worker creates it fresh (guaranteed empty, and therefore safe)
   *  and this passes silently. If it already exists without the app's own ownership marker, this shows a
   *  blocking error dialog explaining the problem and, on "Ok", closes the app entirely - there is nothing
   *  productive the app can do until the user edits config.json themselves to point at a location that does
   *  not exist yet, so continuing to run the rest of the UI would be misleading.
   *
   *  @return true if app startup should continue, false if the app is being closed. */
  private async checkTempDataDirectoryOwnership(): Promise<boolean> {
    let result: { ok: boolean, path: string, message: string };
    try {
      result = (await ipc.ensureTempDataDirectoryOwnership()).res;
    } catch (error) {
      // console.warn, not console.error: a dedicated dialog for this specific check would be redundant, not just
      // unnecessary - see "Fails open" below for why a real ownership problem still gets caught (and shown to
      // the user) elsewhere regardless of whether this particular check succeeded.
      console.warn('Failed to verify the temp/cache directory', error);
      // Fails open (lets startup continue) rather than blocking on an unrelated failure (e.g. an IPC hiccup) -
      // every function that actually touches this directory (getTempDataDirectoryPath,
      // partitionBackupToOpticalMedia, clearTempDataDirectory) performs this same ownership check again
      // itself before doing anything, so a real ownership problem is still caught before anything unsafe
      // happens - just without this dedicated startup dialog.
      return true;
    }

    if (result.ok) {
      return true;
    }

    await new Promise<void>((resolve) => {
      const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
      errorDialog.disableClose = true;
      errorDialog.componentInstance.title = "Temp directory problem";
      errorDialog.componentInstance.message = result.message;
      errorDialog.componentInstance.actionsNum = 1;
      errorDialog.componentInstance.action1Label = "Ok";
      errorDialog.componentInstance.action1Callback = () => {
        errorDialog.close();
        resolve();
      }
    });

    window.electronAPI.quitApp();
    return false;
  }

  /** On startup, OFFERS to clear the app's temp/cache directory (used as a buffer for large-file splits, and
   *  for .ibb project files, before they are burned to optical media - see partitionBackupToOpticalMedia and
   *  createIBB_file in worker.ts) whenever it actually has something left over in it. This is purely a disk-
   *  space courtesy, not a correctness requirement: every "Backup to optical media"/"Add missing files" job
   *  generates its own per-job session subfolder there (see SESSION_FOLDER_NAME_PATTERN in worker.ts) and only
   *  ever reads/writes inside it, so a leftover subfolder from an earlier, abandoned job can never be mistaken
   *  for - or silently reused as - anything belonging to a new job. If the directory is already empty, this
   *  does nothing at all - no snackbar, no IPC call.
   *
   *  When there IS something to clear, a snackbar (not a blocking dialog - nothing here needs the user's
   *  permission, since leaving it alone is completely safe) offers a "Clear" action, shown for 10 seconds and
   *  then auto-dismissed if left untouched - ignoring it costs nothing but some disk space, and the same offer
   *  simply reappears next launch. Only actually clicking "Clear" deletes anything, and doing so DOES then
   *  block the app behind a non-cancelable loading dialog for the duration of the delete - see the comment
   *  on the "Clear" subscription below for why.
   *
   *  Deliberately a main-menu-only offer: MainMenuComponent's own goToFeature() dismisses this snackbar
   *  synchronously before navigating to any of the 6 features, since MatSnackBar is a root-provided singleton -
   *  no reference-passing needed for that dismiss() to reach the exact snackbar opened here. This component
   *  itself never lives long enough for a stale offer to be an issue (the app fully reloads - see
   *  goToMainMenuAndReload - every time the user returns to the main menu), but the snackbar's own 10-second
   *  auto-dismiss timer alone would otherwise let it linger on top of whatever feature screen the user
   *  navigated to in the meantime. */
  private async clearTempDataDirectoryOnStartup(): Promise<void> {
    try {
      const check: { path: string, hasLeftovers: boolean, entryNames: string[] } = (await ipc.checkTempDataDirectoryForLeftovers()).res;
      if (!check.hasLeftovers) {
        return;
      }

      const snackBarRef = this.snackBar.open(
        `Found ${check.entryNames.length} leftover item(s) from a previous session in the temp directory.`,
        'Clear',
        { duration: 10_000, horizontalPosition: 'end', verticalPosition: 'top' }
      );

      // Blocks on a non-cancelable loading dialog for the duration of the actual delete, rather than leaving
      // the app fully interactive while it runs: clearTempDataDirectory() deletes EVERY recognized entry
      // present in the temp directory at the moment it runs, not just the ones this check reported - so a
      // brand new job started (and far enough along to have created its own session subfolder there) while
      // this runs would have its own in-progress files deleted right out from under it. Blocking the app for
      // this one short operation closes that off.
      snackBarRef.onAction().subscribe(async () => {
        const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
        loadingDialogRef.componentInstance.showCancelButton = false;
        loadingDialogRef.componentInstance.message = "Clearing temporary files";
        try {
          const response = await ipc.clearTempDataDirectory();
          const result: { cleared: boolean; message: string; deletedItems: string[]; notClearedItems: string[] } = response.res;
          loadingDialogRef.close();
          if (!result.cleared) {
            // `cleared` is also false for a PARTIAL clear (some entries deleted, others skipped or failed - see
            // clearTempDataDirectory's own doc comment) - result.message already distinguishes that case from a
            // total failure (e.g. "Cleared 3 of 4 item(s)..." vs "Refusing to clear: ..."), so the title stays
            // deliberately generic rather than assuming nothing was cleared.
            const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '700px' });
            errorDialog.componentInstance.title = "Temp directory not fully cleared";
            errorDialog.componentInstance.message = result.message;
            if (result.notClearedItems?.length) {
              errorDialog.componentInstance.lists = [{ label: `Not cleared (${result.notClearedItems.length}):`, items: result.notClearedItems }];
            }
            errorDialog.componentInstance.actionsNum = 1;
            errorDialog.componentInstance.action1Label = "Ok";
            errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); }
          }
        } catch (error) {
          loadingDialogRef.close();
          // Kept as console.error (dialog'd), unlike the background check below: the user explicitly clicked
          // "Clear" for this one, and the loading spinner above just vanished with no other feedback - staying
          // silent here would leave them with no idea whether it worked.
          console.error('Failed to clear the temp data directory after the startup snackbar\'s "Clear" action', error);
        }
      });
    } catch (error) {
      // console.warn: this is a passive startup check offering to clear leftovers (see this method's own doc
      // comment) - if it fails, the offer just doesn't show this launch, and it always tries again next launch.
      // Nothing the user did, nothing lost by staying quiet about it.
      console.warn('Failed to check the temp data directory for leftovers on startup', error);
    }
  }

  reloadAppAndGoToMainMenu(){
    goToMainMenuAndReload(this.router);
  }
}
