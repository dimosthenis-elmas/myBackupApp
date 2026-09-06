import { Component, OnInit } from '@angular/core';
import { ElectronService } from './core/services';
import { TranslateService } from '@ngx-translate/core';
import { APP_CONFIG } from '../environments/environment';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmationDialogComponent } from './shared/components/confirmation-dialog/confirmation-dialog.component';
import { WorkerCommunicator as ipc } from '../../app/workers/worker-communicator';
import { PART_FILE_PATTERN } from './shared/utils/part-file-pattern';

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
    private dialog: MatDialog
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
      await this.checkAndFixMissingConfigPaths();

      const tempDirectoryIsUsable = await this.checkTempDataDirectoryOwnership();
      if (!tempDirectoryIsUsable) {
        // The app is being closed (see checkTempDataDirectoryOwnership) - nothing after this point should run.
        return;
      }

      await this.clearTempDataDirectoryOnStartup();
    }
  }

  /** On startup, checks whether config.json is missing the required executable paths (7-Zip, ImgBurn - see
   *  validateConfigPaths in worker.ts). This covers config.json being missing entirely, being empty, or
   *  simply not having been filled in yet (the README currently asks the user to edit this file by hand) -
   *  as well as a path that no longer points to an existing file (e.g. the program was moved or uninstalled).
   *  For each missing one, the user is walked through a native file picker to locate it, with the option to
   *  skip. Anything they provide is saved back to config.json (merged in - nothing else in the file is
   *  touched). This never blocks app startup - skipping just means the optical-media features that need that
   *  path will fail when actually used, same as today, until it is configured (here or by hand).
   *
   *  Gating: showing this dialog is NOT based on whether the configured paths currently exist on disk.
   *  config.json ships with hardcoded default paths (the developer's own install locations) - on some machines
   *  those coincidentally already exist (e.g. 7-Zip/ImgBurn installed at their usual default location) without
   *  the user ever having actually confirmed them for this install. So a `setupAcknowledged` flag is persisted
   *  to config.json once the user has been through this flow at least once (whether they filled in every field
   *  or skipped some) - the dialog appears on every startup until that flag is set (asking about EVERY
   *  required field, not just currently-invalid ones - see requiredFields vs missingFields below), and never
   *  automatically again afterwards, even if a path stops existing later (e.g. uninstalled). */
  private async checkAndFixMissingConfigPaths(): Promise<void> {
    let validation: {
      config: { [key: string]: any },
      missingFields: Array<{ key: string, label: string }>,
      requiredFields: Array<{ key: string, label: string }>
    };
    try {
      validation = (await ipc.validateConfigPaths()).res;
    } catch (error) {
      console.error('Failed to validate the app configuration', error);
      return;
    }

    if (validation.config && validation.config['setupAcknowledged']) {
      // Already been through this flow once (or since the last time config.json was deleted/reset) - never
      // nag automatically again.
      return;
    }

    await new Promise<void>((resolve) => {
      const introDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
      introDialog.disableClose = true;
      introDialog.componentInstance.title = "Setup required";
      introDialog.componentInstance.message =
        `Please confirm the following paths, required for the optical media backup features (splitting, ` +
        `reassembling, and burning large files) to work: ` +
        `${validation.requiredFields.map(f => f.label).join(', ')}. You'll now be asked to locate each one - ` +
        `you can also skip this and set it later yourself in appData\\config.json.`;
      introDialog.componentInstance.actionsNum = 1;
      introDialog.componentInstance.action1Label = "Ok";
      introDialog.componentInstance.action1Callback = () => {
        introDialog.close();
        resolve();
      }
    });

    const updates: { [key: string]: any } = {};
    const missingKeys = new Set((validation.missingFields || []).map(f => f.key));
    // Ask about every required field, not just validation.missingFields - a shipped default path that happens
    // to already exist on this machine still hasn't actually been confirmed by this user (see the gating
    // comment above). Skipping a field here leaves its current value (default or otherwise) untouched.
    for (const field of validation.requiredFields) {
      // If this field's current config.json value already points at a real file (i.e. it's not in
      // missingFields), pre-select it in the picker so confirming it is a single click rather than having to
      // browse to it again from scratch.
      const currentValue = validation.config ? validation.config[field.key] : undefined;
      const currentValidPath = (!missingKeys.has(field.key) && typeof currentValue === 'string' && currentValue.trim() !== '')
        ? currentValue
        : undefined;
      const chosenPath = await this.chooseExecutablePathWithRetry(field.label, currentValidPath);
      if (chosenPath) {
        updates[field.key] = chosenPath;
      }
    }

    // Always mark setup as acknowledged at this point, even if every field was skipped - the dialog has done
    // its job of asking, and per the "then don't display the dialog any more" requirement it should not keep
    // reappearing on every subsequent startup just because some fields were left unset.
    updates['setupAcknowledged'] = true;

    try {
      const response = await ipc.updateConfig(updates);
      const result: { success: boolean; message: string } = response.res;

      const resultDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
      resultDialog.componentInstance.title = result.success ? "Configuration saved" : "Could not save configuration";
      resultDialog.componentInstance.message = result.message;
      resultDialog.componentInstance.actionsNum = 1;
      resultDialog.componentInstance.action1Label = "Ok";
      resultDialog.componentInstance.action1Callback = () => { resultDialog.close(); }
    } catch (error) {
      console.error('Failed to save the app configuration', error);
    }
  }

  /** Asks the user to locate one required executable via a native file picker. If they cancel, offers to
   *  retry or skip. Resolves to the chosen path, or undefined if skipped. Does not touch config.json itself -
   *  the caller collects all chosen paths and saves them together.
   *
   *  If currentValidPath is given (the field's current config.json value, already confirmed to point at an
   *  existing file), the picker opens with that file pre-selected - the native dialog opens directly in its
   *  folder with the filename pre-filled, so the user only has to press the select button to confirm it
   *  rather than hunt the file down again. Left undefined, the picker just opens with nothing pre-selected. */
  private async chooseExecutablePathWithRetry(label: string, currentValidPath?: string): Promise<string | undefined> {
    const dialogConfig: { [key: string]: any } = {
      title: `Select the ${label}`,
      buttonLabel: 'Select',
      properties: ['openFile'],
      filters: [{ name: 'Executable', extensions: ['exe'] }]
    };
    if (currentValidPath) {
      dialogConfig['defaultPath'] = currentValidPath;
    }
    const res = await window.electronAPI.openDialog('showOpenDialog', dialogConfig);
    const chosenPath: string | undefined = (res.filePaths && res.filePaths.length > 0) ? res.filePaths[0] : undefined;

    if (chosenPath) {
      return chosenPath;
    }

    return new Promise<string | undefined>((resolve) => {
      const infoDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
      infoDialog.disableClose = true;
      infoDialog.componentInstance.title = "Nothing selected";
      infoDialog.componentInstance.message = `You did not select a path for the ${label}. This feature will not work until it is configured.`;
      infoDialog.componentInstance.actionsNum = 2;
      infoDialog.componentInstance.action1Label = "Retry";
      infoDialog.componentInstance.action2Label = "Skip";
      infoDialog.componentInstance.action1Callback = async () => {
        infoDialog.close();
        resolve(await this.chooseExecutablePathWithRetry(label, currentValidPath));
      }
      infoDialog.componentInstance.action2Callback = () => {
        infoDialog.close();
        resolve(undefined);
      }
    });
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
      console.error('Failed to verify the temp/cache directory', error);
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

  /** On startup, clears the app's temp/cache directory (used as a buffer for large-file splits, and for .ibb
   *  project files, before they are burned to optical media - see partitionBackupToOpticalMedia and
   *  createIBB_file in worker.ts) whenever it actually has something left over in it - nothing in there can
   *  ever safely carry over to a new session: a backup/burn job has no resume support (see confirmedDiscs in
   *  backup-to-optical-media.component.ts), so a piece left behind by an earlier, abandoned session is not a
   *  head start on a later one - it is stale, and reusing it could even silently serve wrong data (e.g. if the
   *  source file it was split from has since changed). If the directory is already empty, this does nothing at
   *  all - no dialog, no IPC call to actually clear it - since there would be nothing to tell the user about.
   *
   *  When there IS something to clear, the user is informed first (itemizing exactly what will be removed) but
   *  is not offered a way to decline - there is deliberately only one action ("Ok"), which triggers the clear
   *  once clicked. Any failure here is logged and, unlike the happy path, does get its own dialog so a real
   *  failure is not silently swallowed - but it never blocks app startup either way. */
  private async clearTempDataDirectoryOnStartup(): Promise<void> {
    try {
      const tempDataDirectoryPath = (await ipc.getTempDataDirectoryPath()).res;
      const filesWithStats: Array<{ path: string }> = (await ipc.getFilePathsWithStats(tempDataDirectoryPath)).res;
      const ibbProjectFilePattern = /Disk_\d+\.ibb$/i;
      const leftoverFiles = (filesWithStats || []).filter((f) => PART_FILE_PATTERN.test(f.path) || ibbProjectFilePattern.test(f.path));

      if (leftoverFiles.length === 0) {
        return;
      }

      // Shown to the user so the dialog below lists exactly what will be removed, not just "the directory is
      // not empty" - strips the temp directory's own path prefix off each entry so the list reads as paths
      // relative to it, which is what the user actually recognizes (part-file/ibb names), rather than the full
      // absolute path repeated on every line.
      const relativeLeftoverPaths = leftoverFiles.map((f) => {
        const p = f.path;
        return p.startsWith(tempDataDirectoryPath)
          ? p.slice(tempDataDirectoryPath.length).replace(/^[\\/]+/, '')
          : p;
      });
      const leftoverFilesList = relativeLeftoverPaths.map((p) => `  • ${p}`).join('\n');

      await new Promise<void>((resolve) => {
        const infoDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
        infoDialog.disableClose = true;
        infoDialog.componentInstance.title = "Clearing temporary files";
        infoDialog.componentInstance.message =
          `This app does not support resuming a backup/burn job across restarts, so anything left over in its ` +
          `temporary directory ("${tempDataDirectoryPath}") from an earlier session is cleared now, before ` +
          `continuing.\n\nThe following ${leftoverFiles.length} file(s) will be removed:\n${leftoverFilesList}`;
        infoDialog.componentInstance.actionsNum = 1;
        infoDialog.componentInstance.action1Label = "Ok";
        infoDialog.componentInstance.action1Callback = () => {
          infoDialog.close();
          resolve();
        }
      });

      const response = await ipc.clearTempDataDirectory();
      const result: { cleared: boolean; message: string; deletedItems: string[] } = response.res;
      if (!result.cleared) {
        const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '450px' });
        errorDialog.componentInstance.title = "Could not clear temp directory";
        errorDialog.componentInstance.message = result.message;
        errorDialog.componentInstance.actionsNum = 1;
        errorDialog.componentInstance.action1Label = "Ok";
        errorDialog.componentInstance.action1Callback = () => { errorDialog.close(); }
      }
    } catch (error) {
      console.error('Failed to clear the temp data directory on startup', error);
    }
  }

  reloadAppAndGoToMainMenu(){
    this.router.navigate(['main-menu'])
    .then(() => {
        window.location.reload();
    });
  }
}
