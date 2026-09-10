import { WorkerChannel } from './ipc.interfaces';
import { WorkerCommunicator as ipc } from './worker-communicator'

export class LogsBuffer {

    private channel: WorkerChannel;
    private size: number;
    private buffer: Array<String>;
    private index: number;
    private flushRate: number; // in milliseconds
    private flushTimestamp: number; // when did the last flush occur?

    constructor(size: number = 10000, flushRate: number = 250){
      this.size = size;
      this.buffer = new Array<String>(this.size);
      this.flushRate = flushRate;
      this.flushTimestamp = 0;
      this.index = 0;
      this.channel = "unknown-channel";
    }
  
    public push(item: String) {
      this.buffer[ this.index++ ] = item;
      if(this.index == this.size){
        this.flush();
      } else{
        let now:number = performance.now();
        if( (now - this.flushTimestamp) > this.flushRate){
            this.flushTimestamp = now;
            console.log("flushing...");
            this.flush();
        }
     }
    }
  
    /** No-op when nothing is actually buffered (this.index === 0). Every caller that unconditionally calls this
     *  right after its own operation resolves (the "whatever remained in the buffer" pattern - see worker.ts's
     *  ipcMain switch/case) does so regardless of whether anything was actually pushed during that run (e.g. a
     *  small enough diff()/createTree() call may never hit a progress-report interval at all) - without this
     *  guard, that sends a spurious empty `status: "running"` response on the SAME channel key right before the
     *  operation's real "completed"/"stopped" response. Harmless for a channel whose completed payload is
     *  always null, but a caller resolving on the first response for a key without checking its status (unlike
     *  WorkerCommunicator.sendAndAwaitResponse, which correctly does) would wrongly treat that empty running
     *  message as the final answer for a channel whose completed payload carries real data. */
    public flush(){
      if (this.index === 0) { return; }
      ipc.sendResponseToMain({ key: this.channel, res: this.buffer.slice(0, this.index), status: "running" });
      this.index = 0;
    }
  
    public setChannel(channel: WorkerChannel){
      this.channel = channel;
    }

  }