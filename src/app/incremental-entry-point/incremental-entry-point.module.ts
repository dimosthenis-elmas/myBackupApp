import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { IncrementalEntryPointRoutingModule } from './incremental-entry-point-routing.module';

import { IncrementalEntryPointComponent } from './incremental-entry-point.component';
import { SharedModule } from '../shared/shared.module';
import {MatButtonModule} from '@angular/material/button';
import {MatButtonToggleModule} from '@angular/material/button-toggle';
import {MatDividerModule} from '@angular/material/divider'
import {MatTooltipModule} from '@angular/material/tooltip';
import {MatChipsModule} from '@angular/material/chips';
import { MatIconModule } from "@angular/material/icon";
import { MatCardModule } from '@angular/material/card';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatInputModule} from '@angular/material/input';
import {MatSelectModule} from '@angular/material/select';
import {FormsModule} from '@angular/forms';
import {MatTabsModule} from '@angular/material/tabs';
import {RecoverDataFromOpticalMediaModule} from '../recover-data-from-optical-media/recover-data-from-optical-media.module'
import {SyncDirsModule} from '../sync-dirs/sync-dirs.module'


@NgModule({
  declarations: [IncrementalEntryPointComponent],
  imports: [
    CommonModule,
    SharedModule,
    IncrementalEntryPointRoutingModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatDividerModule,
    MatTooltipModule,
    MatChipsModule,
    MatIconModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    FormsModule,
    MatTabsModule,
    RecoverDataFromOpticalMediaModule,
    SyncDirsModule
  ],
})
export class IncrementalEntryPointModule {}
