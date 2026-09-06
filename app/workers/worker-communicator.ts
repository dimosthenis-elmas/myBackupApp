/* Note about this file:
This used to have the exact same ~25-line listener-registration/resolve/reject block copy-pasted once per
worker method below (17 times). It has been collapsed into the one sendAndAwaitResponse helper - every method
is now a single call into it, parameterized by the WorkerChannel key, the request params, and (see the
rejectPayload note on sendAndAwaitResponse) which of the two reject-payload shapes that method's existing
callers already depend on. Adding a new worker service should now just mean adding one new method here (plus
its case in worker.ts's switch and its key in ipc.interfaces.ts's WorkerChannel union), not copy-pasting this
whole pattern again.
*/


import { filesMetadata, IElectronAPI } from '../../src/types/interface'
import { WorkerChannel, WorkerRequest, WorkerResponse, OpticalMediaPartitioning, WorkerListener } from './ipc.interfaces'



export class WorkerCommunicator {
    // ========================================================================
    // ===== MAIN
    // ========================================================================

    static sendRequestToWorker(request: WorkerRequest): void {
        window.electronAPI.ipcRenderer_send('message-to-worker', request);
    }

    /** Must be called inside "ngAfterViewInit()"
     * Don't forget to call onDestroy to remove all listeners.
    */
    static onResponseFromWorker(fun: (event: Electron.IpcRendererEvent, response: WorkerResponse) => void): WorkerListener {
        let listener;
        window.electronAPI.ipcRenderer_on('message-from-worker', listener = (event: Electron.IpcRendererEvent, arg: WorkerResponse) => {
            fun(event, arg);
        });
        return { removeListener: () => { window.electronAPI.ipcRenderer_removeListener('message-from-worker', listener); } };
    }

    static onDestroy() {
        window.electronAPI.ipcRenderer_removeAllListeners();
    }

    // ========================================================================
    // ===== WORKER
    // ========================================================================

    static sendResponseToMain(response: WorkerResponse): void {
        window.electronAPI.ipcRenderer_send('response-to-main', response);
    }

    /** Must be called inside "ngAfterViewInit()" */
    static onRequestFromMain(fun: (event: Electron.IpcRendererEvent, request: WorkerRequest) => void): void {
        window.electronAPI.ipcRenderer_on('message-from-main', (event, arg) => {
            console.log(JSON.stringify(arg))
            fun(event, arg);
        });
    }

    // ========================================================================
    // ===== REQUEST/RESPONSE HELPER (see the file-level comment above)
    // ========================================================================

    /** Number of sendAndAwaitResponse calls currently either running or waiting in queue - i.e. how many
     *  "commands" the worker is being asked to get through right now. Used only to decide whether a brand new
     *  call needs the "worker is busy" warning (see sendAndAwaitResponse) - it does NOT gate whether a call is
     *  allowed to proceed; queueTail below is what actually serializes execution. */
    private static inFlightCount = 0;

    /** Tasks queued (via queueTail) but not yet actually sent to the worker - i.e. sendRequestToWorker has not
     *  been called for them yet. stop() rejects each of these DIRECTLY, immediately (not by waiting for its
     *  turn in the queue) with a "cancelled" reason, and empties this array - see stop() and the "settled"
     *  handling inside sendAndAwaitResponse for how that stays safe to do even though the same task will also
     *  reach the front of the queue eventually. This is deliberately separate from whatever request is
     *  currently actually running (if any): that one is interrupted through the normal process.env._stop
     *  mechanism instead (see worker.ts) and settles on its own, typically with status: 'stopped' - stop()
     *  does not reach into that one directly, only into requests that never got a chance to be sent at all. */
    private static pendingCancelTasks: Array<{ key: WorkerChannel, reject: (reason: any) => void }> = [];

    /** Tail of the serialization queue every sendAndAwaitResponse call chains onto - resolves once a given
     *  call's turn is fully done (whether that meant a real worker round-trip, or the call being skipped
     *  because it was cancelled while still waiting), so the next queued call never starts early. Always
     *  resolves (never rejects) by construction, so one queued call failing does not stall whatever is queued
     *  behind it. This only paces WHEN each call's own work begins - it is not what determines when a
     *  cancelled call's caller-facing promise settles; see the "settled" handling in sendAndAwaitResponse for
     *  why those are kept independent (so cancelling a still-queued call rejects it immediately, without
     *  making its caller wait for whatever is currently running to also finish first). */
    private static queueTail: Promise<void> = Promise.resolve();

    /** Sends a single request to the worker for `key` with `params`, and resolves/rejects a Promise based on
     *  its response - this is the one place the send-then-listen-then-resolve/reject pattern every method
     *  below used to hand-roll individually now lives.
     *
     *  Behavior, matching exactly what every method below did before this was extracted:
     *   - `status: 'completed'` or `'stopped'` -> resolves with the full WorkerResponse (cast to T - see
     *     partitionBackupToOpticalMedia for the one method that needs a different response shape than plain
     *     WorkerResponse).
     *   - `status: 'error'` -> rejects. With WHAT depends on `rejectPayload`:
     *       - 'response' (the default): rejects with the full WorkerResponse object.
     *       - 'response.res': rejects with just its `res` field.
     *     This split is not a stylistic choice made here - it reflects a real difference each of these
     *     methods already had before this refactor, which at least one caller actually depends on (e.g.
     *     incremental.component.ts's onError assigns the rejected value directly as a dialog's displayed
     *     message, which only makes sense for the plain, already-unwrapped 'response.res' shape). Unifying
     *     this silently during a refactor would have been an easy way to introduce a regression that no
     *     compiler would catch, so it is preserved explicitly per call instead.
     *   - Any other key while this one is in flight (or a stray 'stop' acknowledgement) is handled the same
     *     way for every method: 'stop' is ignored, anything else is treated as "the previous command on this
     *     shared channel hasn't finished yet" and rejects with a descriptive string.
     *
     *  Queueing: this worker only supports one in-flight command at a time (see worker.ts's own comments to
     *  that effect) - previously that was only a convention every caller happened to follow (always await
     *  before sending the next command). It's now actually enforced here: calls are chained onto queueTail, so
     *  a second call made before the first has settled will not have its request sent to the worker until the
     *  first is done, rather than racing it on the shared 'message-from-worker' channel (where whichever
     *  settled first would call ipcRenderer_removeAllListeners and silently strand the other's listener
     *  forever). A console.warn is logged whenever a call actually has to wait for another one, so an
     *  unexpectedly serialized call is visible during debugging rather than just quietly taking longer.
     *
     *  The caller-facing promise and the queue's own pacing are deliberately kept independent (via the
     *  `settled` flag and the resolve/reject wrappers below), rather than the queued continuation being the
     *  only thing that can ever settle it: that is what lets WorkerCommunicator.stop() reject a still-queued
     *  call immediately, without waiting for whatever is currently running to finish first. */
    private static sendAndAwaitResponse<T = WorkerResponse>(
        key: WorkerChannel,
        params: any,
        rejectPayload: 'response' | 'response.res' = 'response'
    ): Promise<T> {
        if (this.inFlightCount > 0) {
            console.warn(`Warning: the request for "${key}" got queued because the worker is busy.`);
        }
        this.inFlightCount++;

        let settled = false;
        let resolveCaller!: (value: T) => void;
        let rejectCaller!: (reason: any) => void;
        const callerPromise = new Promise<T>((resolve, reject) => {
            // Idempotent on purpose: whichever of "the queue reached this call's turn and it completed
            // normally" or "stop() cancelled it while it was still waiting" happens first is the only one
            // that actually takes effect - the other becomes a no-op instead of a "settling an
            // already-settled promise" error.
            resolveCaller = (value) => { if (!settled) { settled = true; resolve(value); } };
            rejectCaller = (reason) => { if (!settled) { settled = true; reject(reason); } };
        });

        const cancelTask = { key, reject: rejectCaller };
        this.pendingCancelTasks.push(cancelTask);

        // Drives queueTail's pacing (see its own comment) - resolves once this call's turn is fully handled,
        // one way or another. Deliberately does NOT itself resolve/reject callerPromise for the cancelled
        // case - resolveCaller/rejectCaller already ran (from stop()) by the time this executes, and the
        // `settled` check above makes this a safe no-op.
        const runWhenItsMyTurn = (): Promise<void> => {
            const index = this.pendingCancelTasks.indexOf(cancelTask);
            if (index !== -1) { this.pendingCancelTasks.splice(index, 1); }

            if (settled) {
                // Already cancelled by stop() while this was still waiting its turn - never send anything.
                return Promise.resolve();
            }

            this.sendRequestToWorker({ key, params });
            return new Promise<void>((resolveTurn) => {
                const listener = (event: Electron.IpcRendererEvent, response: WorkerResponse) => {
                    if (response.key === key) {
                        if (response.status === 'completed' || response.status === 'stopped') {
                            window.electronAPI.ipcRenderer_removeAllListeners('message-from-worker');
                            resolveCaller(response as unknown as T);
                            resolveTurn();
                        } else if (response.status === 'error') {
                            window.electronAPI.ipcRenderer_removeAllListeners('message-from-worker');
                            rejectCaller(rejectPayload === 'response.res' ? response.res : response);
                            resolveTurn();
                        }
                    } else if (response.key === 'stop') {
                        // do nothing, ignore this one.
                    } else {
                        const err = `It is possible that the previous command has not finished and you sent ${key} to the worker. `
                            + `This worker only supports one command at a time. Use await or .then() before sending the next command`;
                        console.error(err);
                        rejectCaller(err);
                        resolveTurn();
                    }
                };
                window.electronAPI.ipcRenderer_on('message-from-worker', listener);
            });
        };

        // Chain onto the queue tail, running regardless of whether the previous queued call's turn ended in
        // success or failure (both handlers are runWhenItsMyTurn itself) - one call failing must not block
        // whatever is queued behind it.
        this.queueTail = this.queueTail.then(runWhenItsMyTurn, runWhenItsMyTurn);

        callerPromise.then(() => { this.inFlightCount--; }, () => { this.inFlightCount--; });

        return callerPromise;
    }

    /** Interrupts whatever worker command is currently running (via the usual process.env._stop mechanism -
     *  see worker.ts - the running command settles on its own afterwards, typically with status: 'stopped'),
     *  and separately, immediately rejects every call still queued behind it that has not been sent yet (see
     *  pendingCancelTasks) - those reject right away instead of silently running later once the current one
     *  finishes (or making their own caller wait for the current one to finish just to find out they were
     *  cancelled), which is what a user pressing "cancel" actually expects to happen. Replaces every previous
     *  call site's raw `sendRequestToWorker({key: 'stop', params: undefined})` - going through this method
     *  instead of that directly is what makes the "cancel the queue too" half actually take effect. */
    static stop(): void {
        this.sendRequestToWorker({ key: 'stop', params: undefined });

        if (this.pendingCancelTasks.length > 0) {
            console.warn(`Warning: cancelling ${this.pendingCancelTasks.length} queued request(s) that had not been sent to the worker yet.`);
        }
        const toCancel = this.pendingCancelTasks;
        this.pendingCancelTasks = [];
        toCancel.forEach(task => { task.reject(`The queued request for "${task.key}" was cancelled before it was sent.`); });
    }

    // ========================================================================
    // ====================backup services API
    //=========================================================================

    static incrementalPreview(sourceOnlyPaths: Array<string>, sourcePath: string, targetPath: string): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('incremental-preview', {
            sourceOnlyPaths: sourceOnlyPaths,
            source: sourcePath,
            target: targetPath
        }, 'response.res');
    }

    static incrementalCopyFiles(sourceOnlyPaths: Array<string>, sourcePath: string, targetPath: string): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('incremental-copy-files', {
            sourceOnlyPaths: sourceOnlyPaths,
            source: sourcePath,
            target: targetPath
        }, 'response.res');
    }

    /** @param commit false previews the operation only (nothing is actually deleted - see worker.ts's
     *  deleteFilesAndDirsForDirSync, whose own `commit` parameter this is passed straight through to,
     *  unmodified); true actually performs the deletions. Named (and typed) to match that worker-side parameter
     *  exactly - it used to be called `previewOnly` here despite carrying the opposite sense with no inversion
     *  anywhere in between, which happened to still work only because every call site already passed values as
     *  if this were `commit` (false to preview, true to commit) rather than what its old name promised. */
    static deleteFilesAndDirsForDirSync(pathsMarkedForDeletion: Array<string>, commit: boolean, source: string, target: string): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('delete-files-and-dirs-for-dir-sync', {
            pathsMarkedForDeletion: pathsMarkedForDeletion,
            source: source,
            target: target,
            commit: commit
        }, 'response.res');
    }

    static partitionBackupToOpticalMedia(rootPath: string, mediaCapacityInBytes: number, splitLargeFiles: boolean = false, filesMetadata?: filesMetadata[]): Promise<OpticalMediaPartitioning<WorkerResponse>> {
        return this.sendAndAwaitResponse<OpticalMediaPartitioning<WorkerResponse>>('partition-backup-to-optical-media', {
            rootPath: rootPath,
            mediaCapacityInBytes: mediaCapacityInBytes,
            splitLargeFiles: splitLargeFiles,
            filesMetadata: filesMetadata
        });
    }

    static createIBB_file(disk_id: number, paths: Array<string>, sourcePath: string, volumeLabel?: string): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('create-IBB-file', {
            disk_id: disk_id,
            paths: paths,
            sourcePath: sourcePath,
            volumeLabel: volumeLabel
        });
    }

    static waitForOpticalDiskToBeMounted(): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('wait-for-optical-disk-to-be-mounted', {});
    }

    static getFilePaths(sourceDir: string): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('get-file-paths', { sourceDir: sourceDir });
    }

    static getTempDataDirectoryPath(): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('get-temp-data-directory-path', {});
    }

    /** Applies config.json's maxOpticalMediumRepletionRatio to a medium's raw rated capacity - see
     *  getEffectiveOpticalMediumCapacityInBytes in worker.ts for why this is the capacity every fit check
     *  (not just up-front planning) should compare against, never a medium's raw capacity directly. */
    static getEffectiveOpticalMediumCapacity(rawCapacityInBytes: number): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('get-effective-optical-medium-capacity', { rawCapacityInBytes: rawCapacityInBytes });
    }

    static readJSONfromDisk(path: string): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('read-json-from-disk', { path: path });
    }

    static writeJSONtoDisk(path: string, json: Object): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('write-json-to-disk', { path: path, json: json });
    }

    static getFilePathsWithStats(dirPath: string): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('get-file-paths-with-stats', { dirPath: dirPath });
    }

    static diff(sourcePath: string, targetPath: string): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('diff', {
            source: sourcePath,
            target: targetPath
        }, 'response.res');
    }

    static mergeFileParts(partFilePaths: Array<string>, originalFileName: string): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('merge-file-parts', {
            partFilePaths: partFilePaths,
            originalFileName: originalFileName
        });
    }

    static clearTempDataDirectory(): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('clear-temp-data-directory', {});
    }

    /** Physically splits (via real 7-Zip) whichever large files `paths` references that haven't been split yet,
     *  and returns fresh, real stats for every path - see materializeOpticalMediaDiscPieces in worker.ts. The
     *  response's `res` array can be longer than `paths` (a rare, known boundary case surfaces one extra,
     *  unplanned piece - see that function's own comment) - callers should build their disc's saved metadata
     *  from the full response, not by zipping it against the original request. */
    static materializeOpticalMediaDiscPieces(dirPath: string, paths: Array<string>): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('materialize-optical-media-disc-pieces', { dirPath: dirPath, paths: paths });
    }

    /** Deletes exactly the given real, absolute temp-dir piece paths - see deleteMaterializedPiecesForDisc in
     *  worker.ts. Never deletes a whole file's other pieces if they belong to a different, not-yet-confirmed
     *  disc - only the exact paths passed in. */
    static deleteMaterializedPiecesForDisc(pieceAbsolutePaths: Array<string>): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('delete-materialized-pieces-for-disc', { pieceAbsolutePaths: pieceAbsolutePaths });
    }

    static validateConfigPaths(): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('validate-config-paths', {});
    }

    static updateConfig(updates: { [key: string]: any }): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('update-config', { updates: updates });
    }

    static ensureTempDataDirectoryOwnership(): Promise<WorkerResponse> {
        return this.sendAndAwaitResponse('ensure-temp-directory-ownership', {});
    }

}
