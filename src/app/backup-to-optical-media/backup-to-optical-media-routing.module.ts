import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { BackupToOpticalMediaComponent } from './backup-to-optical-media.component';




const routes: Routes = [
  {
    path: 'backup-to-optical-media',
    component: BackupToOpticalMediaComponent
  }
];

@NgModule({
  declarations: [],
  imports: [CommonModule, RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class BackupToOpticalMediaRoutingModule {}
