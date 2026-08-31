import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { IncrementalCopyingComponent } from './incremental-copying.component';

const routes: Routes = [
  {
    path: 'incremental-copying',
    component: IncrementalCopyingComponent
  }
];

@NgModule({
  declarations: [],
  imports: [CommonModule, RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class IncrementalCopyingRoutingModule {}
