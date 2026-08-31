import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { TranslateModule } from '@ngx-translate/core';

import { PageNotFoundComponent } from './components';
import { ConfirmationDialogComponent } from './components';
import { WebviewDirective } from './directives/';
import { FormsModule } from '@angular/forms';
import { LoadingDialogComponent } from './components';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';

@NgModule({
  declarations: [PageNotFoundComponent, ConfirmationDialogComponent, LoadingDialogComponent, WebviewDirective],
  imports: [CommonModule, TranslateModule, FormsModule, MatProgressSpinnerModule, MatButtonModule, MatDialogModule],
  exports: [TranslateModule, WebviewDirective, FormsModule]
})
export class SharedModule {}
