import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ScrollableListComponent } from './scrollable-list.component';
import { SharedModule } from '../shared/shared.module';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import {ScrollingModule} from '@angular/cdk/scrolling';

@NgModule({
  declarations: [ScrollableListComponent],
  imports: [
    CommonModule,
    SharedModule,
    
    ScrollingModule
  ],
  exports: [ScrollableListComponent]
})
export class ScrollableListModule {}
