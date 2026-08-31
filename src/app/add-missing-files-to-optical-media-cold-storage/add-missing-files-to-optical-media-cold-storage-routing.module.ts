import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { AddMissigFilesToOpticalMediaColdStorageComponent } from './add-missing-files-to-optical-media-cold-storage.component';




const routes: Routes = [
  {
    path: 'add-missing-files-to-optical-media-cold-storage',
    component: AddMissigFilesToOpticalMediaColdStorageComponent
  }
];

@NgModule({
  declarations: [],
  imports: [CommonModule, RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class AddMissigFilesToOpticalMediaColdStorageRoutingModule {}
