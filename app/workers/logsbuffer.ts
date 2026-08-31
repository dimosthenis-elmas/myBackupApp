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
  
    public flush(){
      ipc.sendResponseToMain({ key: this.channel, res: this.buffer.slice(0, this.index), status: "running" });
      this.index = 0;
    }
  
    public setChannel(channel: WorkerChannel){
      this.channel = channel;
    }

  }