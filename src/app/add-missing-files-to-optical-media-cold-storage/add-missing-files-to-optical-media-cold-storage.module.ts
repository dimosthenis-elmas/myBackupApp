import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { AddMissigFilesToOpticalMediaColdStorageRoutingModule } from './add-missing-files-to-optical-media-cold-storage-routing.module';

import { AddMissigFilesToOpticalMediaColdStorageComponent } from './add-missing-files-to-optical-media-cold-storage.component';
import { SharedModule } from '../shared/shared.module';
import {FilesTreeModule} from '../files-tree/files-tree.module';
import {MatButtonModule} from '@angular/material/button';
import {MatCardModule} from '@angular/material/card';
import {MatCheckboxModule} from '@angular/material/checkbox';
import {MatDividerModule} from '@angular/material/divider';
import {MatBadgeModule} from '@angular/material/badge';
import {MatExpansionModule} from '@angular/material/expansion';
import {MatChipsModule} from '@angular/material/chips';
import { MatIconModule } from "@angular/material/icon";
import { OpticalDiscBackupDataRetrieverModule } from '../optical-disc-backup-data-retriever/optical-disc-backup-data-retriever.module';




@NgModule({
  declarations: [AddMissigFilesToOpticalMediaColdStorageComponent],
  imports: [],
})
export class AddMissigFilesToOpticalMediaColdStorageModule {}
