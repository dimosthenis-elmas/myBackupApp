import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { IncrementalRoutingModule } from './incremental-routing.module';

import { IncrementalComponent } from './incremental.component';
import { SharedModule } from '../shared/shared.module';
import {FilesTreeModule} from '../files-tree/files-tree.module';
import {MatButtonModule} from '@angular/material/button';
import {MatCardModule} from '@angular/material/card';
import {MatCheckboxModule} from '@angular/material/checkbox';
import {MatDividerModule} from '@angular/material/divider';
import {MatBadgeModule} from '@angular/material/badge';
import {MatExpansionModule} from '@angular/material/expansion';

@NgModule({
  declarations: [IncrementalComponent],
  imports: [
    CommonModule,
    SharedModule,
    IncrementalRoutingModule,
    FilesTreeModule,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatDividerModule,
    MatBadgeModule,
    MatExpansionModule
  ],
})
export class IncrementalModule {}
