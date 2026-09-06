'use strict';

/**
 * A real app launch shows a "Clearing temporary files" dialog before anything else on screen is usable - but
 * only CONDITIONALLY, when the temp/cache directory actually has real leftover content in it (see
 * clearTempDataDirectoryOnStartup in app.component.ts: the app has no resume-across-restarts support, so
 * anything left over from an earlier session is stale and gets cleared, with the user told first - but if it's
 * already empty, nothing happens at all, not even an empty "nothing to do" dialog). When it DOES appear, it's
 * modal (disableClose: true, only one "Ok" action, no way to skip it) and sits over the entire app - nothing on
 * the main menu or any wizard screen is clickable until it's dismissed.
 *
 * Every script under ui/ that clicks through the real on-screen app must call this immediately after
 * launchApp(), before its own first click - it resolves immediately (a short, bounded wait to confirm the
 * dialog really isn't coming) if the dialog never shows, which is the common case here: every ui/ script's own
 * pre-launch check (assertRealTempDataDirectoryIsSafeToUse) already requires the real temp dir to be empty
 * before the app is even launched. Scoped to this dialog's own title (not just any "Ok" button - several other
 * dialogs across the app use that same label) so it can never match the wrong dialog.
 *
 * worker-ipc/ scripts do NOT need this: they only ever send IPC messages directly
 * (window.electronAPI.ipcRenderer_send) and never click anything on screen, so a modal overlay sitting over the
 * (otherwise unused) UI has no effect on them.
 */
async function dismissStartupTempClearDialog(win, timeoutMs = 30_000) {
  // Bounded independently of timeoutMs (which still governs the actual dismiss steps below, for the rare case
  // there IS something to clear) - long enough that a genuinely slow app startup doesn't false-negative into
  // "it's not coming", short enough that the overwhelmingly common "nothing to clear" case doesn't needlessly
  // slow down every single script that calls this.
  const appeared = await win.getByText('Clearing temporary files', { exact: true })
    .waitFor({ timeout: Math.min(10_000, timeoutMs) })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    return;
  }

  await win.getByRole('dialog').getByRole('button', { name: 'Ok', exact: true }).click({ timeout: timeoutMs });

  // Not enough to just click "Ok" - when it appears at all, this is the app's first-ever dialog, opened this
  // early (before the router has even settled), and Angular Material's CDK overlay has a known category of
  // bugs where an early overlay's backdrop (and the aria-hidden it puts on the rest of the app while open)
  // doesn't fully tear down even though the dialog itself is visually gone - found for real: the "Path to
  // backup" button painted fine in a screenshot but was invisible to getByRole for 30+ seconds, which is
  // exactly that signature (visible, but hidden from the accessibility tree). Waiting for both the dialog text
  // AND the CDK backdrop to actually leave the DOM - not just clicking past them - is what actually proves the
  // overlay finished closing.
  await win.getByText('Clearing temporary files', { exact: true }).waitFor({ state: 'hidden', timeout: timeoutMs });
  await win.locator('.cdk-overlay-backdrop').waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {
    // No backdrop element at all (rather than one still present) is also a valid "fully closed" state -
    // waitFor(detached) on a locator that never matched anything can reject instead of resolving depending on
    // timing, so a rejection here isn't itself proof anything is wrong.
  });
}

module.exports = { dismissStartupTempClearDialog };
