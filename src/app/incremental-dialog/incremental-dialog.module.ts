import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { IncrementalDialogComponent } from './incremental-dialog.component';
import { SharedModule } from '../shared/shared.module';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { ScrollableListModule } from '../scrollable-list/scrollable-list.module'
import {MatProgressBarModule} from '@angular/material/progress-bar';

@NgModule({
  declarations: [IncrementalDialogComponent],
  imports: [
    CommonModule,
    SharedModule,
    MatButtonModule,
    MatDialogModule,
    ScrollableListModule,
    MatProgressBarModule
  ],
})
export class IncrementalDialogModule {}
