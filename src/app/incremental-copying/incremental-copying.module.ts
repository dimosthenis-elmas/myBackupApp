import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { IncrementalCopyingComponent } from './incremental-copying.component';
import { SharedModule } from '../shared/shared.module';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { ScrollableListModule } from '../scrollable-list/scrollable-list.module';
import { IncrementalCopyingRoutingModule } from './incremental-copying-routing.module';
import {MatExpansionModule} from '@angular/material/expansion';
import { MatCardModule } from '@angular/material/card';
import {MatProgressBarModule} from '@angular/material/progress-bar';

@NgModule({
  declarations: [IncrementalCopyingComponent],
  imports: [
    CommonModule,
    SharedModule,
    MatButtonModule,
    MatDialogModule,
    
    ScrollableListModule,
    IncrementalCopyingRoutingModule,
    MatExpansionModule,
    MatCardModule,
    MatProgressBarModule
  ],
})
export class IncrementalCopyingModule {}
