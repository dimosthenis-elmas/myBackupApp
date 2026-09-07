import { Router } from '@angular/router';

/** The one, single way anywhere in this app should ever send the user back to the main menu - always via a
 *  full page reload (window.location.reload(), after the navigation itself settles), never a bare
 *  router.navigate(['main-menu']) on its own.
 *
 *  Why this matters: BackupService (providedIn: 'root', so one instance for the app's entire lifetime) holds
 *  real state - sourcePath, targetPath, opticalMediaPartitioning, and a couple of RxJS Subjects/a Subscription
 *  - that nothing but a fresh page load actually clears. A plain router.navigate() only swaps which routed
 *  component is on screen; it does not reset that shared state, and does not guarantee every worker IPC
 *  listener a component registered (ipc.onResponseFromWorker) got torn down either - individual components'
 *  own ngOnDestroy cleanup for that is inconsistent (some are thorough, some do nothing at all). A full reload
 *  is what actually guarantees a clean slate regardless of any one component's own cleanup being complete.
 *
 *  Every "send the user back to the main menu" call site in the app - the toolbar's own Home icon, every
 *  wizard's cancel/error paths, everywhere - should go through this, not call router.navigate(['main-menu'])
 *  directly. */
export function goToMainMenuAndReload(router: Router): void {
  router.navigate(['main-menu']).then(() => {
    window.location.reload();
  });
}
