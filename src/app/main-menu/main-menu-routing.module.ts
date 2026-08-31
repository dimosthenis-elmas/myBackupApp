import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { MainMenuComponent } from './main-menu.component';




const routes: Routes = [
  {
    path: 'main-menu',
    component: MainMenuComponent
  }
];

@NgModule({
  declarations: [],
  imports: [CommonModule, RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class MainMenuRoutingModule {}
