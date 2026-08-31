import { NgModule } from '@angular/core';
import { MainMenuComponent } from './main-menu.component';
import { MatIconModule } from "@angular/material/icon";
import { SharedModule } from '../shared/shared.module';
import {MatButtonModule} from '@angular/material/button';
import {MatCardModule} from '@angular/material/card';
import {MatDividerModule} from '@angular/material/divider'


@NgModule({
  declarations: [MainMenuComponent],
  imports: [
    MatIconModule,
    SharedModule,
    MatButtonModule,
    MatCardModule,
    MatDividerModule
  ],
  exports: [MainMenuComponent],
})
export class MainMenuModule {}
