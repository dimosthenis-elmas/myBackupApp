import { Injectable } from '@angular/core';
import { Observable, Subscription, Observer, Subject } from 'rxjs';
import { ColdStorageMetadata } from '../../../../../app/workers/ipc.interfaces';

@Injectable({
  providedIn: 'root'
})
export class BackupService {

  constructor() {}
  
  public sourcePath!: string;

  public targetPath!: string;

  // Partitioning to optical media. This holds the paths of the files to be written to the optical disks.
  public opticalMediaPartitioning!: ColdStorageMetadata;

  public previewLogsStream = new Subject<string[]>();

  public mode = {
    value: "incremental"
  }

 public selectedTabIndex = 0;

 public messsage_queue = new Subject()

  public mySubscription!: Subscription;

  public resetStream = ()=>{
    this.previewLogsStream.complete();
    this.previewLogsStream.unsubscribe();
    this.previewLogsStream = new Subject<string[]>();
  }
  
  fill_message_queue() {
    this.messsage_queue.next(3)
    this.messsage_queue.next(4)
    this.messsage_queue.next(5)
    this.messsage_queue.next(6)
    this.messsage_queue.complete();
  }  

  subscribe_to_message_queue(){
    if(this.mySubscription){
      this.mySubscription.unsubscribe();
    }
    this.mySubscription = this.messsage_queue.subscribe((res) => {
      console.log(' A ' + res)
    })
  }

  unsubscribe_from_message_queue(){
    if(this.mySubscription){
      console.log("unsubscribed");
      this.mySubscription.unsubscribe();
    }else{
      console.log("this is null!")
    }
  }

}
