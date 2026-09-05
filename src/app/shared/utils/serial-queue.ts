/** A tiny FIFO queue of async tasks that run strictly one at a time, in enqueue order.
 *
 *  Used to serialize a read-modify-write cycle against a single shared resource (here: a cold storage metadata
 *  JSON file on disk) across multiple call sites that may fire close together - e.g. a non-linear stepper where
 *  every disc's "Send to ImgBurn" button is always enabled, so nothing stops the user from triggering it for a
 *  second disc before the first one's write has finished. Without this, a later read landing before an earlier
 *  write finishes silently loses that earlier write (overwritten by the later write, which was based on a now
 *  stale read).
 *
 *  Extracted from backup-to-optical-media.component.ts's original metadataUpdateQueue field/pattern (a private
 *  chained promise, the same shape WorkerCommunicator.queueTail already uses for the analogous problem on the
 *  worker IPC channel itself) so add-missing-files-to-optical-media-cold-storage.component.ts, which needs the
 *  exact same guarantee, doesn't have to duplicate it. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  /** Runs `task` once every previously-enqueued task has settled (whether it succeeded or failed - one task
   *  failing must not stall whatever is queued behind it), and returns a promise for `task`'s own result. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
