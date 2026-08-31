import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { IncrementalEntryPointComponent } from './incremental-entry-point.component';

const routes: Routes = [
  {
    path: 'incremental-entry-point',
    component: IncrementalEntryPointComponent
  }
];

@NgModule({
  declarations: [],
  imports: [CommonModule, RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class IncrementalEntryPointRoutingModule {}
