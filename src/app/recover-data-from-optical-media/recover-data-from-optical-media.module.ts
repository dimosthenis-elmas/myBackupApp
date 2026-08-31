import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { RecoverDataFromOpticalMediaRoutingModule } from './recover-data-from-optical-media-routing.module';

import { RecoverDataFromOpticalMediaComponent } from './recover-data-from-optical-media.component';
import { SharedModule } from '../shared/shared.module';
import {FilesTreeModule} from '../files-tree/files-tree.module';
import {MatButtonModule} from '@angular/material/button';
import {MatCardModule} from '@angular/material/card';
import {MatCheckboxModule} from '@angular/material/checkbox';
import {MatDividerModule} from '@angular/material/divider';
import {MatBadgeModule} from '@angular/material/badge';
import {MatExpansionModule} from '@angular/material/expansion';
import { MatIconModule } from "@angular/material/icon";
import {MatChipsModule} from '@angular/material/chips';
import {MatTabsModule} from '@angular/material/tabs';
import {MatListModule} from '@angular/material/list';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import { ScrollableListModule } from '../scrollable-list/scrollable-list.module';
import {MatProgressBarModule} from '@angular/material/progress-bar';
import { MatStepperModule } from '@angular/material/stepper';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import {MatInputModule} from '@angular/material/input';
import { OpticalDiscBackupDataRetrieverModule } from '../optical-disc-backup-data-retriever/optical-disc-backup-data-retriever.module';





@NgModule({
  declarations: [RecoverDataFromOpticalMediaComponent],
  imports: [
    CommonModule,
    SharedModule,
    RecoverDataFromOpticalMediaRoutingModule,
    FilesTreeModule,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatDividerModule,
    MatBadgeModule,
    MatExpansionModule,
    MatIconModule,
    MatChipsModule,
    MatTabsModule,
    MatListModule,
    MatProgressSpinnerModule,
    ScrollableListModule,
    MatProgressBarModule,
    MatStepperModule,
    FormsModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    OpticalDiscBackupDataRetrieverModule
  ],
  exports: [RecoverDataFromOpticalMediaComponent],
})
export class RecoverDataFromOpticalMediaModule {}
