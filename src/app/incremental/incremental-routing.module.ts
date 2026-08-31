import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { IncrementalComponent } from './incremental.component';

const routes: Routes = [
  {
    path: 'incremental',
    component: IncrementalComponent
  }
];

@NgModule({
  declarations: [],
  imports: [CommonModule, RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class IncrementalRoutingModule {}
