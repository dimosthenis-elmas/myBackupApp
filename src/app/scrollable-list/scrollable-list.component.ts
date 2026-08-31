import { Component, OnInit, OnDestroy, NgZone, AfterViewInit, ViewChild, ElementRef, QueryList, ChangeDetectionStrategy } from '@angular/core';
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import { BackupService } from '../core/services/backup/backup.service';
import { CollectionViewer, DataSource, ListRange } from '@angular/cdk/collections';
import { CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { WorkerCommunicator as ipc } from '../../../app/workers/worker-communicator'
import { ParseTreeResult } from '@angular/compiler';

@Component({
  selector: 'app-scrollable-list',
  templateUrl: './scrollable-list.component.html',
  styleUrls: ['./scrollable-list.component.scss'],
 // changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScrollableListComponent {
  @ViewChild(CdkVirtualScrollViewport) viewport!: CdkVirtualScrollViewport;
  @ViewChild(CdkVirtualForOf) vrlist!: CdkVirtualForOf<any>;
  @ViewChild(CdkVirtualScrollViewport) vsv!: CdkVirtualScrollViewport;

  private scrollSubscription!: Subscription;
  dataSource = new MyDataSource(this.backup, this.scrollToBottom.bind(this), this.getVSV.bind(this));
  constructor(private backup: BackupService, private ngZone: NgZone) {
    //this.dataSource = new LogsDataSource(this.backup, this.scrollToBottom.bind(this) ,this.onLogsCompleted.bind(this));
    
  }

  ngAfterViewInit(): void {

    /*
    this.scrollSubscription = this.vsv.renderedRangeStream.subscribe((ls: ListRange) => {
      setTimeout(() => {
        this.vsv.scrollTo({ bottom: 0 })
      });
    });
    */

  }

  scrollToBottom(){
    setTimeout(() => {
      this.vsv.scrollTo({ bottom: 0 })
    });
  }

  getVSV():CdkVirtualScrollViewport{
    return this.vsv;
  }

}

export class LogsDataSource extends DataSource<string | undefined> {
  private cachedLogs = Array.from<string>({ length: 0 });
  private dataStream = new BehaviorSubject<(string | undefined)[]>(this.cachedLogs);
  private subscription = new Subscription();

  constructor(private backup: BackupService, private scrollToBottom: ()=>void, private onCompleted: (totalLogs: string[])=>void) {
    super();
  }

  connect(collectionViewer: CollectionViewer): Observable<(string | undefined)[] | ReadonlyArray<string | undefined>> {
    this.subscription.add(
      this.backup.previewLogsStream.subscribe(
        (logsArray) => {
          this.cachedLogs = this.cachedLogs.concat(logsArray);
          this.dataStream.next(this.cachedLogs);
          this.scrollToBottom();
          //console.log(this.cachedLogs);
        },
        (err) => {

        },
        () => {
          console.log("COMPLETED");
          this.onCompleted([]);
        }),

    );
    return this.dataStream;
  }

  disconnect(collectionViewer: CollectionViewer): void {
    this.subscription.unsubscribe();
  }

}

export class MyDataSource extends DataSource<string | undefined> {
  private _length = 0;
  private _pageSize = 10;
  public _cachedData = Array.from<string>({length: this._length});
  private _fetchedPages = new Set<number>();
  private _dataStream = new BehaviorSubject<(string | undefined)[]>(this._cachedData);
  private _subscription = new Subscription();
  private scrollingAnimationCapacity = 10;
  private restOfLogs: string[] = [];
  public totalLogsCount = 0;
  public streamFinished = false;
  private holdOn = (ms:number=0) => {
    return new Promise<void>(resolve =>
      setTimeout(() => {
        resolve();
      },ms)
    );
  }
  constructor(private backup: BackupService, private scrollToBottom: ()=>void, private getVSV: ()=>CdkVirtualScrollViewport) {
    super();
  }

  

  streamFinishedPromise(){
    return new Promise<void>(async(resolve) =>{
      while(!this.streamFinished){
        await this.holdOn();
      }
      resolve();
    });
  }

  connect(collectionViewer: CollectionViewer): Observable<(string | undefined)[]> {
    this.streamFinished = false;
    let afterLogsCompleted = () => {
      this._subscription.add(collectionViewer.viewChange.subscribe(range => {
        //console.log(" range : " + range.start + " - " + range.end );
        const startPage = this._getPageForIndex(range.start);
        const endPage = this._getPageForIndex(range.end - 1);
        //console.log("range index : " + startPage + " - " + endPage)
        for (let i = startPage; i <= endPage; i++) {
          this._fetchPage(i);
        }
      }))
    };

    this._subscription.add(
      this.backup.previewLogsStream.subscribe(
        //show next batch of logs
        (partialLogsArray) => {
          /*PartialLogsArray is an array containing a batch of logs sent by the worker when it does: logsBuffer.push("foo")
          The items pushed in logsBuffer are automatically flushed (i.e. sent to the main process, (here)) either after several
          milliseconds or on specific request (e.g. after conpleting the function which produces the logs).
          This is done in order not to overload the processes with exessive ipc calls.
          The _cachedData variable stores all the items we want to diplay (everything, the entire list) at some point.
          The restOfLogs variable serves as a sort of buffer because we want to show some scrollingAnimationCapacity items and then scroll to bottom.
          */
          this.totalLogsCount = this.totalLogsCount + partialLogsArray.length;
          this.restOfLogs = this.restOfLogs.concat(partialLogsArray);
          let itemsToShow = this.restOfLogs.splice(0, this.scrollingAnimationCapacity);
          this._cachedData = this._cachedData.concat(itemsToShow);
          this._dataStream.next(this._cachedData);
          this.scrollToBottom();          
        },
        (err) => {
          //error
          this.streamFinished = true;
        },
        () => {
          //completed
          console.log("total number of logs: " + this.totalLogsCount);
          while(this.restOfLogs.length){
            let itemsToShow = this.restOfLogs.splice(0, this.scrollingAnimationCapacity);
            this._cachedData = this._cachedData.concat(itemsToShow);
            this._dataStream.next(this._cachedData);
            this.scrollToBottom();
          }
          this.streamFinished = true;          
        }),
    );

    return this._dataStream;
  }

  disconnect(): void {
    this._subscription.unsubscribe();
  }

  private _fillPageWithOmittedItems(pageStart: number, pageEnd: number) {
    /*let ri;
    console.log(this.restOfLogs.length)
    this.restOfLogs.forEach((element, index) => {
      if (element.index >= pageStart && element.index <= pageEnd) {
        this._cachedData.splice(element.index, 0, ...element.extralogs);
        ri = index;
        console.log("index to remove: " + ri)
      }
    });*/
    //this.restOfLogs.splice(ri, 1);
    
  }

  private _getPageForIndex(index: number): number {
    return Math.floor(index / this._pageSize);
  }

  private _fetchPage(page: number) {
    if (this._fetchedPages.has(page)) {
      console.log("page exists in set")
      return;
    }
    this._fetchedPages.add(page);

    // Use `setTimeout` to simulate fetching data from server.
   
      if(page * this._pageSize + this._pageSize > this._cachedData.length ){
        let lastPageSize = this._cachedData.length - page * this._pageSize;
        //this is the last page. In this case we have to take into account the fact that the page size may be greater than the elements availeble.
        console.log("page indexes :" +(page * this._pageSize) + " - " + (page * this._pageSize + lastPageSize))
        /*this._cachedData.splice(page * this._pageSize, lastPageSize,
          ...Array.from({ length: lastPageSize })
            .map((_, i) => {return this._cachedData[page * this._pageSize + i]}));*/
        this._fillPageWithOmittedItems(page * this._pageSize, page * this._pageSize + lastPageSize);
        this._dataStream.next(this._cachedData);
      } else {
        console.log("page indexes :" +(page * this._pageSize) + " - " + (page * this._pageSize + this._pageSize))
        /*this._cachedData.splice(page * this._pageSize, this._pageSize,
          ...Array.from({ length: this._pageSize })
            .map((_, i) => {return this._cachedData[page * this._pageSize + i]}));*/
        this._fillPageWithOmittedItems(page * this._pageSize, page * this._pageSize + this._pageSize);
        this._dataStream.next(this._cachedData);
      }
      
    
  }
}




