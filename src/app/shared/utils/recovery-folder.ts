import { MatDialog } from '@angular/material/dialog';
import { ConfirmationDialogComponent } from '../components/confirmation-dialog/confirmation-dialog.component';
import { WorkerCommunicator as ipc } from '../../../../app/workers/worker-communicator';

/** Recovery only copies into an empty folder, so that no file already there is ever replaced. Resolves 'empty' if
 *  `folder` is empty. Otherwise tells the user why it cannot be used, and resolves what they chose: with
 *  `offerAnotherFolder`, 'choose-folder' or 'cancel'; without (they choose again on the same screen), 'cancel'. */
export async function confirmRecoveryFolderIsEmpty(dialog: MatDialog, folder: string, offerAnotherFolder: boolean): Promise<'empty' | 'choose-folder' | 'cancel'> {
  const state: 'empty' | 'not-empty' | 'missing' = (await ipc.recoveryFolderState(folder)).res;
  if (state === 'empty') { return 'empty'; }
  return new Promise((resolve) => {
    const ref = dialog.open(ConfirmationDialogComponent, { maxWidth: '550px' });
    ref.disableClose = true;
    ref.componentInstance.title = 'Choose an empty folder';
    ref.componentInstance.message = (state === 'missing' ? `"${folder}" no longer exists. ` : `"${folder}" is not empty. `) +
      `The app recovers files only into an empty folder, so that no file already there can be replaced. Choose an ` +
      `empty folder, or create a new one.`;
    if (offerAnotherFolder) {
      ref.componentInstance.actionsNum = 2;
      ref.componentInstance.action1Label = 'Cancel';
      ref.componentInstance.action1Callback = () => { ref.close(); resolve('cancel'); };
      ref.componentInstance.action2Label = 'Choose another folder';
      ref.componentInstance.action2Callback = () => { ref.close(); resolve('choose-folder'); };
    } else {
      ref.componentInstance.actionsNum = 1;
      ref.componentInstance.action1Label = 'Ok';
      ref.componentInstance.action1Callback = () => { ref.close(); resolve('cancel'); };
    }
  });
}
