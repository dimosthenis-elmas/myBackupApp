import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { SyncDirsComponent } from './sync-dirs.component';




const routes: Routes = [
  {
    path: 'sync-dirs',
    component: SyncDirsComponent
  }
];

@NgModule({
  declarations: [],
  imports: [CommonModule, RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class SyncDirsRoutingModule {}
