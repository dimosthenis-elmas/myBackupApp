import { Injectable, NgZone } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmationDialogComponent } from '../../../shared/components/confirmation-dialog/confirmation-dialog.component';
import { ErrorSource, ReportedError, registerErrorDialogHandler, showRelayedError } from '../../../shared/utils/error-log';

/** Plain-language dialog title per origin - avoids surfacing internal implementation terms ("worker", "main
 *  process") to the user, who has no reason to know or care about this app's process architecture. */
const SOURCE_LABELS: Record<ErrorSource, string> = {
  main: 'Application error',
  worker: 'Background service error',
  renderer: 'Application error'
};

/** Shows every reported error (renderer, main process, or worker - see error-log.ts) as a ConfirmationDialogComponent,
 *  one at a time: a second error reported while one is already showing is queued rather than opened on top of it
 *  or dropped, so a burst of errors (e.g. the same failure logged repeatedly inside a loop) is never silently
 *  lost, just shown one after another. Only ever shows `reported.summary` (plain language) as the dialog's main
 *  text - `reported.details` (stack traces, raw dumps) goes into the dialog's collapsed "technical details"
 *  section instead, never the primary message - see ReportedError/splitErrorArgs in error-log.ts.
 *
 *  Must be instantiated early so its constructor's IPC listener and dialog-handler registration are in place
 *  before anything can error - forced via injection in AppComponent's own constructor, the same way
 *  ElectronService is. */
@Injectable({
  providedIn: 'root'
})
export class ErrorReporterService {
  private dialogQueue: Array<{ source: ErrorSource; reported: ReportedError }> = [];
  private dialogShowing = false;

  constructor(private dialog: MatDialog, private ngZone: NgZone) {
    registerErrorDialogHandler((source, reported) => this.enqueue(source, reported));

    const api = (window as any).electronAPI;
    if (api && typeof api.ipcRenderer_on === 'function') {
      // ipcRenderer_on forwards straight to the raw ipcRenderer.on(channel, func) (see contextBridge_api.js) -
      // func is called as (event, arg), not just (arg), same as WorkerCommunicator.onResponseFromWorker's
      // identical two-parameter callback.
      api.ipcRenderer_on('app-error', (event: unknown, arg: { source: ErrorSource } & ReportedError) => {
        showRelayedError(arg.source, { summary: arg.summary, details: arg.details, title: arg.title, lists: arg.lists });
      });
    }
  }

  private enqueue(source: ErrorSource, reported: ReportedError): void {
    this.dialogQueue.push({ source, reported });
    this.showNextIfIdle();
  }

  private showNextIfIdle(): void {
    if (this.dialogShowing || this.dialogQueue.length === 0) { return; }
    this.dialogShowing = true;
    const { source, reported } = this.dialogQueue.shift()!;

    // dialog.open must run inside Angular's zone - this can be reached from an IPC callback (via api.ipcRenderer_on
    // above), which runs outside it.
    this.ngZone.run(() => {
      const errorDialog = this.dialog.open(ConfirmationDialogComponent, { maxWidth: reported.lists?.length ? '700px' : '600px' });
      errorDialog.componentInstance.title = reported.title || SOURCE_LABELS[source];
      errorDialog.componentInstance.message = reported.summary;
      errorDialog.componentInstance.technicalDetails = reported.details || undefined;
      if (reported.lists?.length) { errorDialog.componentInstance.lists = reported.lists; }
      errorDialog.componentInstance.actionsNum = 1;
      errorDialog.componentInstance.action1Label = 'Ok';
      errorDialog.afterClosed().subscribe(() => {
        this.dialogShowing = false;
        this.showNextIfIdle();
      });
    });
  }
}
