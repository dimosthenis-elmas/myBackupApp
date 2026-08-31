import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { BackupToOpticalMediaRoutingModule } from './backup-to-optical-media-routing.module';

import { BackupToOpticalMediaComponent } from './backup-to-optical-media.component';
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




@NgModule({
  declarations: [BackupToOpticalMediaComponent],
  imports: [
    CommonModule,
    SharedModule,
    BackupToOpticalMediaRoutingModule,
    FilesTreeModule,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatDividerModule,
    MatBadgeModule,
    MatExpansionModule,
    MatIconModule,
    MatChipsModule
  ],
})
export class BackupToOpticalMediaModule {}
