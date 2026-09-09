import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatButton } from '@angular/material/button';
import { MatCard, MatCardModule } from '@angular/material/card';
import { MatIcon } from '@angular/material/icon';
import { MatDivider } from '@angular/material/divider';
import { compileSchema } from "json-schema-library";
import { ConfirmationDialogComponent } from '../shared/components/confirmation-dialog/confirmation-dialog.component';
import { LoadingDialogComponent } from '../shared/components/loading-dialog/loading-dialog.component';
import { WorkerCommunicator as ipc } from '../../../app/workers/worker-communicator';
import { ColdStorageMetadata } from '../../../app/workers/ipc.interfaces';
import { getDiscIdHashForPaths, OPTICAL_DRIVE_LETTER_CONVENTION } from '../shared/utils/disc-id-hash';
import { goToMainMenuAndReload } from '../shared/utils/go-to-main-menu';
const mySchema = require('../schemas/filesMetadata.schema.json');

/**
 * Standalone, read-only wizard: "Verify integrity of cold storage disc". Deliberately its own top-level
 * component rather than a mode flag bolted onto OpticalDiscBackupDataRetriever (the recovery flow) - that
 * component's whole shape is built around accumulating ONE combined recovery output across every disc and then
 * copying/merging selected files, none of which applies here (no files-tree selection - always every file on
 * whatever disc is inserted; no target directory; no merge/reassembly offer - each real .partNNN piece is
 * verified directly against its own recorded hash, without ever needing to reassemble anything).
 *
 * What IS reused from the recovery flow: the JSON load/schema-validation shape (afterJSONpathIsGiven in
 * add-missing-files-to-optical-media-cold-storage.component.ts), the "wait for a disc, read its listing,
 * compute a disc-id hash and match it against the loaded metadata" pattern (see
 * readAllDiscsToReconstructTheCompleteBackupFilePaths/seedFromExternalMetadata in
 * optical-disc-backup-data-retriever.component.ts) - via the shared getDiscIdHashForPaths helper rather than a
 * second, separately-typed copy of that hashing step - and the SAME verify-file-hashes worker channel the
 * recovery flow's own post-recovery integrity check uses (see WorkerCommunicator.verifyFileHashes), since that
 * primitive already doesn't care whether a path is a file already copied somewhere or one still sitting
 * directly on a mounted optical disc.
 */
@Component({
  selector: 'verify-cold-storage-integrity',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatButton,
    MatCard,
    MatCardModule,
    MatIcon,
    MatDivider
  ],
  templateUrl: './verify-cold-storage-integrity.component.html',
  styleUrl: './verify-cold-storage-integrity.component.scss'
})
export class VerifyColdStorageIntegrityComponent implements OnInit, OnDestroy {

  step: 'step_1' | 'step_2' = 'step_1';
  metadataJSONPath!: string;
  private metadata!: ColdStorageMetadata;
  /** Precomputed once the JSON is loaded: disc index -> its expected disc-id hash, using the SAME
   *  getDiscIdHashForPaths convention every other disc-identification call site uses. Paths in a loaded JSON
   *  are already OPTICAL_DRIVE_LETTER_CONVENTION-normalized (see seedFromExternalMetadata's own comment), so
   *  they are hashed as-is, without re-adding a drive-letter prefix. */
  private discIdHashes: number[] = [];
  opticalMediumLoaded = false;
  readingDisc = false;
  /** disc index (0-based) -> whether that disc's verification passed, filled in as each disc is actually
   *  verified this session - drives the running tally shown at the "verify another?" prompt. Intentionally
   *  pure in-memory state, never persisted, matching every other wizard's own "no resume support" decision. */
  verifiedDiscs: { [discIndex: number]: boolean } = {};
  /** True from the moment "Choose metadata JSON" is clicked until getJSON() has fully settled (loaded+validated,
   *  rejected, or the user cancelled the file dialog) - guards against a double-click firing getJSON() twice
   *  concurrently (also bound to that button's own [disabled] in the template, so this is a backstop, not the
   *  only thing preventing it), which could otherwise race to set this.metadata/this.step and call
   *  verifyNextDisc() twice. Public so the template can bind to it. */
  public loadingJSON = false;

  constructor(public router: Router, public dialog: MatDialog, private ngZone: NgZone) { }

  ngOnInit(): void {
  }

  ngOnDestroy(): void {
    ipc.stop();
    ipc.onDestroy();
  }

  goToHomePage(): void {
    goToMainMenuAndReload(this.router);
  }

  async chooseFile(): Promise<string> {
    const dialogConfig = {
      title: 'File selection',
      buttonLabel: 'Select file',
      properties: ['openFile']
    };
    const res = await window.electronAPI.openDialog('showOpenDialog', dialogConfig);
    return res.filePaths[0];
  }

  async getJSON(): Promise<void> {
    if (this.loadingJSON) { return; }
    this.loadingJSON = true;
    try {
      await this.getJSONInner();
    } finally {
      this.loadingJSON = false;
    }
  }

  private async getJSONInner(): Promise<void> {
    const path = await this.chooseFile();
    if (path == undefined) { return; }
    this.metadataJSONPath = path;

    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
    loadingDialogRef.componentInstance.showCancelButton = false;
    try {
      const res = (await ipc.readJSONfromDisk(this.metadataJSONPath)).res;
      const schemaNode = compileSchema(mySchema);
      if (!schemaNode.validate(res)) {
        loadingDialogRef.close();
        this.showOkDialog("Error", `This JSON is not recognised as a files metadata type.`);
        return;
      }

      const metadata: ColdStorageMetadata = res;
      const anySha256 = metadata.some(disc => disc.some(f => !!f.stats.sha256));
      if (!anySha256) {
        loadingDialogRef.close();
        // Guard called out explicitly in this feature's own design notes: don't make the user insert a single
        // disc for nothing if the loaded metadata carries no integrity data anywhere at all.
        this.showOkDialog(
          "No integrity data to verify",
          `This cold storage metadata JSON does not contain any SHA-256 integrity data for any file - it was ` +
          `most likely created with the "File integrity data" option set to "None". There is nothing for this ` +
          `wizard to check, so no disc needs to be inserted. Choose a different JSON file, or go back to the ` +
          `main menu.`
        );
        return;
      }

      const discIdHashes = metadata.map(disc => getDiscIdHashForPaths(disc.map(f => f.path)));
      // Same guard seedFromExternalMetadata (optical-disc-backup-data-retriever.component.ts) already applies
      // to this exact JSON shape - without it, two discs producing the same id (an empty disc, or the same
      // disc listed twice) would make discIdHashes.indexOf() always resolve to the FIRST one: the second could
      // never actually be identified/verified - inserting it would just look like "you already verified this
      // disc" forever, even though it never really was.
      if (new Set(discIdHashes).size !== discIdHashes.length) {
        loadingDialogRef.close();
        this.showOkDialog(
          "Error",
          `The provided cold storage metadata JSON looks malformed: two or more discs produce the same ` +
          `identifier (for example, an empty disc, or the same disc listed twice). Please check the JSON file ` +
          `and try again.`
        );
        return;
      }

      this.metadata = metadata;
      this.discIdHashes = discIdHashes;
      loadingDialogRef.close();
      this.step = 'step_2';
      this.verifyNextDisc();
    } catch (error) {
      loadingDialogRef.close();
      this.showOkDialog("Error", `Could not read this JSON file: ${error}`);
    }
  }

  private showOkDialog(title: string, message: string): void {
    const dialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
    dialog.disableClose = true;
    dialog.componentInstance.title = title;
    dialog.componentInstance.message = message;
    dialog.componentInstance.actionsNum = 1;
    dialog.componentInstance.action1Label = "Ok";
    dialog.componentInstance.action1Callback = () => { dialog.close(); }
  }

  private askRetryOrFinish(message: string): void {
    const dialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
    dialog.disableClose = true;
    dialog.componentInstance.title = "Error";
    dialog.componentInstance.message = message;
    dialog.componentInstance.actionsNum = 2;
    dialog.componentInstance.action1Label = "Retry";
    dialog.componentInstance.action2Label = "Finish verifying";
    dialog.componentInstance.action1Callback = () => { dialog.close(); this.verifyNextDisc(); }
    dialog.componentInstance.action2Callback = () => { dialog.close(); this.goToHomePage(); }
  }

  /** True from the moment verifyNextDisc() starts until it (and verifyDisc(), which it awaits) has fully
   *  settled - guards against a rapid double-click on "Retry"/"Verify another disc" firing this twice
   *  concurrently before the dialog's own close animation finishes (each of those dialogs has
   *  disableClose=true and closes itself synchronously on click, but Material's close animation is not
   *  instant - a genuinely fast double-click can still land on the same button before it's actually gone).
   *  Held for the whole chain, not just the "wait for a disc" half - while it's true, every entry point back
   *  into this method (the initial call after loading a JSON, Retry, Verify another disc) is a no-op, which is
   *  safe since none of those buttons are reachable again until a NEW dialog opens anyway (MatDialog's own
   *  modal backdrop already blocks interacting with anything behind the current one). */
  private verifying = false;

  async verifyNextDisc(): Promise<void> {
    if (this.verifying) { return; }
    this.verifying = true;
    try {
      await this.verifyNextDiscInner();
    } finally {
      this.verifying = false;
    }
  }

  private async verifyNextDiscInner(): Promise<void> {
    this.opticalMediumLoaded = false;
    this.readingDisc = false;

    let mountedVolumeLetter: string;
    try {
      const response = await ipc.waitForOpticalDiskToBeMounted();
      mountedVolumeLetter = response.res._mounted;
    } catch (error) {
      this.askRetryOrFinish(`An error occurred while waiting for a disc to be inserted: ${error}`);
      return;
    }
    this.opticalMediumLoaded = true;
    this.readingDisc = true;

    let filePathsWithStats: Array<{ path: string, stats: { size: number, mtime: Date, isDirectory: boolean } }>;
    try {
      filePathsWithStats = (await ipc.getFilePathsWithStats(mountedVolumeLetter)).res;
    } catch (error) {
      this.askRetryOrFinish(`An error occurred while reading the inserted disc: ${error}`);
      return;
    }

    // Same disc-identification convention as recovery (see readAllDiscsToReconstructTheCompleteBackupFilePaths's
    // own comment on why the drive letter is normalized before hashing): a disc's id must not depend on which
    // drive letter Windows happened to mount it as.
    const normalizedPaths = filePathsWithStats.map(f => f.path.replace(/^(\w+:\\)/, OPTICAL_DRIVE_LETTER_CONVENTION));
    const currentDiscIdHash = getDiscIdHashForPaths(normalizedPaths);
    const discIndex = this.discIdHashes.indexOf(currentDiscIdHash);

    if (discIndex === -1) {
      this.askRetryOrFinish(`This disc does not match any disc listed in the loaded cold storage metadata JSON. Are you sure you inserted the right disc?`);
      return;
    }
    if (this.verifiedDiscs[discIndex] !== undefined) {
      this.askRetryOrFinish(`It looks like you have already verified this disc (disc ${discIndex + 1}) during this session. Insert a different disc, or finish.`);
      return;
    }

    await this.verifyDisc(discIndex, mountedVolumeLetter);
  }

  private async verifyDisc(discIndex: number, mountedVolumeLetter: string): Promise<void> {
    // _mounted (see waitForOpticalDiskToBeMounted in worker.ts) is a raw WMI DeviceID (e.g. "E:", no trailing
    // backslash guaranteed) - OPTICAL_DRIVE_LETTER_CONVENTION always carries one ("D:\\"), so a bare string
    // replace between the two would silently drop the backslash after the real drive letter too. Normalized
    // the same way every other "ensure a trailing backslash" call site in this app already does.
    let mountedRoot = mountedVolumeLetter;
    if (mountedRoot[mountedRoot.length - 1] != '\\') { mountedRoot += '\\'; }

    const discEntries = this.metadata[discIndex].filter(f => !f.stats.isDirectory);
    const filesToHash = discEntries
      .filter(f => !!f.stats.sha256)
      .map(f => ({
        absolutePath: f.path.replace(OPTICAL_DRIVE_LETTER_CONVENTION, mountedRoot),
        expectedSha256: f.stats.sha256 as string
      }));
    const noDataCount = discEntries.length - filesToHash.length;

    const loadingDialogRef = this.dialog.open(LoadingDialogComponent, { disableClose: true });
    loadingDialogRef.componentInstance.showCancelButton = false;
    const listener = ipc.onResponseFromWorker((event, response) => {
      this.ngZone.run(() => {
        if (response.key === 'verify-file-hashes' && response.status === 'running') {
          const lines: string[] = response.res;
          if (lines.length) { loadingDialogRef.componentInstance.message = lines[lines.length - 1]; }
        }
      });
    });

    let results: Array<{ path: string, sha256: string, matched?: boolean }> = [];
    try {
      results = filesToHash.length > 0 ? (await ipc.verifyFileHashes(filesToHash)).res : [];
    } catch (error) {
      listener.removeListener();
      loadingDialogRef.close();
      this.askRetryOrFinish(`An error occurred while verifying this disc's files: ${error}`);
      return;
    }
    listener.removeListener();
    loadingDialogRef.close();

    const failedPaths = results.filter(r => !r.matched).map(r => r.path);
    const verifiedCount = results.length - failedPaths.length;
    const passed = failedPaths.length === 0;
    this.verifiedDiscs[discIndex] = passed;

    const shown = failedPaths.slice(0, 15);
    const rest = failedPaths.length - shown.length;
    const resultDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '600px' });
    resultDialog.disableClose = true;
    // "verification successful" only when something was actually checked and matched - a disc with zero hash
    // coverage (every file on it lacks a recorded sha256) would otherwise claim success despite nothing having
    // been verified at all, the same trap avoided on the recovery side by not mentioning integrity when there's
    // nothing to check (see verifyRecoveredFileIntegrity's own undefined-return case).
    resultDialog.componentInstance.title = !passed
      ? `Disc ${discIndex + 1}: verification FAILED`
      : verifiedCount > 0
        ? `Disc ${discIndex + 1}: verification successful`
        : `Disc ${discIndex + 1}: no integrity data available`;
    resultDialog.componentInstance.message =
      `Verified: ${verifiedCount}. No integrity data available: ${noDataCount}. FAILED: ${failedPaths.length}.` +
      (failedPaths.length > 0
        ? `  The following files did NOT match their recorded hash - this can mean real data corruption (a bad drive read, disc handling damage): ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.`
        : '');
    resultDialog.componentInstance.actionsNum = 1;
    resultDialog.componentInstance.action1Label = "Ok";
    resultDialog.componentInstance.action1Callback = () => {
      resultDialog.close();
      this.askVerifyAnother();
    }
  }

  private askVerifyAnother(): void {
    const tally = Object.keys(this.verifiedDiscs)
      .map(k => parseInt(k, 10))
      .sort((a, b) => a - b)
      .map(i => `disc ${i + 1} ${this.verifiedDiscs[i] ? 'passed' : 'FAILED'}`)
      .join(', ');

    const dialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
    dialog.disableClose = true;
    dialog.componentInstance.title = "Verify another disc?";
    dialog.componentInstance.message = `Verified so far this session - ${tally}. Insert another disc to verify, or finish.`;
    dialog.componentInstance.actionsNum = 2;
    dialog.componentInstance.action1Label = "Verify another disc";
    dialog.componentInstance.action2Label = "Finish";
    dialog.componentInstance.action1Callback = () => { dialog.close(); this.verifyNextDisc(); }
    dialog.componentInstance.action2Callback = () => { dialog.close(); this.goToHomePage(); }
  }

}
