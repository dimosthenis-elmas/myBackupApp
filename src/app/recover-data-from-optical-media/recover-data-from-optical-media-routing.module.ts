import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { RecoverDataFromOpticalMediaComponent } from './recover-data-from-optical-media.component';




const routes: Routes = [
  {
    path: 'recover-data-from-optical-media',
    component: RecoverDataFromOpticalMediaComponent
  }
];

@NgModule({
  declarations: [],
  imports: [CommonModule, RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class RecoverDataFromOpticalMediaRoutingModule {}
