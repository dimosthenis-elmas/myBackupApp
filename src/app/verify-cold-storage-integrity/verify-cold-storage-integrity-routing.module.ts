import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { VerifyColdStorageIntegrityComponent } from './verify-cold-storage-integrity.component';

const routes: Routes = [
  {
    path: 'verify-cold-storage-integrity',
    component: VerifyColdStorageIntegrityComponent
  }
];

@NgModule({
  declarations: [],
  imports: [CommonModule, RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class VerifyColdStorageIntegrityRoutingModule {}
