import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';


import { FilesTreeComponent } from './files-tree.component';
import { SharedModule } from '../shared/shared.module';
import {MatTreeModule} from '@angular/material/tree';
import {MatCheckboxModule} from '@angular/material/checkbox';
import {MatIconModule} from '@angular/material/icon';
import {CdkTreeModule} from '@angular/cdk/tree';
import {MatButtonModule} from '@angular/material/button';
import {MatButtonToggleModule} from '@angular/material/button-toggle';
import { ScrollingModule } from '@angular/cdk/scrolling';

@NgModule({
  declarations: [FilesTreeComponent],
  imports: [
    CommonModule,
    SharedModule,
    MatTreeModule,
    MatCheckboxModule,
    MatIconModule,
    CdkTreeModule,
    MatButtonModule,
    MatButtonToggleModule,
    ScrollingModule,
  ],
  exports: [FilesTreeComponent]
})
export class FilesTreeModule {}
