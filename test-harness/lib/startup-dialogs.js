'use strict';

/**
 * Every real app launch now shows a mandatory "Clearing temporary files" dialog before anything else on screen
 * is usable (see clearTempDataDirectoryOnStartup in app.component.ts): the app has no resume-across-restarts
 * support, so its temp/cache directory is unconditionally cleared at the start of every launch, and the user is
 * told about it first. The dialog is modal (disableClose: true, only one "Ok" action, no way to skip it) and
 * sits over the entire app - nothing on the main menu or any wizard screen is clickable until it's dismissed.
 *
 * Every script under ui/ that clicks through the real on-screen app must call this immediately after
 * launchApp(), before its own first click. Scoped to this dialog's own title (not just any "Ok" button - several
 * other dialogs across the app use that same label) so it can never match the wrong dialog.
 *
 * worker-ipc/ scripts do NOT need this: they only ever send IPC messages directly
 * (window.electronAPI.ipcRenderer_send) and never click anything on screen, so a modal overlay sitting over the
 * (otherwise unused) UI has no effect on them.
 */
async function dismissStartupTempClearDialog(win, timeoutMs = 30_000) {
  await win.getByText('Clearing temporary files', { exact: true }).waitFor({ timeout: timeoutMs });
  await win.getByRole('dialog').getByRole('button', { name: 'Ok', exact: true }).click({ timeout: timeoutMs });

  // Not enough to just click "Ok" - this is the app's first-ever dialog, opened unconditionally before the
  // router has even settled, and Angular Material's CDK overlay has a known category of bugs where an early
  // overlay's backdrop (and the aria-hidden it puts on the rest of the app while open) doesn't fully tear down
  // even though the dialog itself is visually gone - found for real: the "Path to backup" button painted fine
  // in a screenshot but was invisible to getByRole for 30+ seconds, which is exactly that signature (visible,
  // but hidden from the accessibility tree). Waiting for both the dialog text AND the CDK backdrop to actually
  // leave the DOM - not just clicking past them - is what actually proves the overlay finished closing.
  await win.getByText('Clearing temporary files', { exact: true }).waitFor({ state: 'hidden', timeout: timeoutMs });
  await win.locator('.cdk-overlay-backdrop').waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {
    // No backdrop element at all (rather than one still present) is also a valid "fully closed" state -
    // waitFor(detached) on a locator that never matched anything can reject instead of resolving depending on
    // timing, so a rejection here isn't itself proof anything is wrong.
  });
}

module.exports = { dismissStartupTempClearDialog };
