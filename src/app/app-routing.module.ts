import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';
import { PageNotFoundComponent } from './shared/components';
import { IncrementalEntryPointComponent } from './incremental-entry-point/incremental-entry-point.component'

import { IncrementalEntryPointRoutingModule } from './incremental-entry-point/incremental-entry-point-routing.module';

const routes: Routes = [
  {
    path: '',
    redirectTo: 'main-menu',
    pathMatch: 'full'
  },
  {
    path: '**',
    component: IncrementalEntryPointComponent
  }
];

@NgModule({
  imports: [
    RouterModule.forRoot(routes, {}),
    IncrementalEntryPointRoutingModule,
  ],
  exports: [RouterModule]
})
export class AppRoutingModule { }
