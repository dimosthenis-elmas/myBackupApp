import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { SyncDirsRoutingModule } from './sync-dirs-routing.module';

import { SyncDirsComponent } from './sync-dirs.component';
import { SharedModule } from '../shared/shared.module';
import {MatButtonModule} from '@angular/material/button';
import {MatCardModule} from '@angular/material/card';
import {MatDividerModule} from '@angular/material/divider';
import {MatBadgeModule} from '@angular/material/badge';
import { MatIconModule } from "@angular/material/icon";
import {MatChipsModule} from '@angular/material/chips';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import { ScrollableListModule } from '../scrollable-list/scrollable-list.module';
import {MatProgressBarModule} from '@angular/material/progress-bar';






@NgModule({
  declarations: [SyncDirsComponent],
  imports: [
    CommonModule,
    SharedModule,
    SyncDirsRoutingModule,
    MatButtonModule,
    MatCardModule,
    MatDividerModule,
    MatBadgeModule,
    MatIconModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    ScrollableListModule,
    MatProgressBarModule
  ],
  exports: [SyncDirsComponent],
})
export class SyncDirsModule {}
