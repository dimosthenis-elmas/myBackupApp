import { BrowserModule } from '@angular/platform-browser';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { CoreModule } from './core/core.module';
import { SharedModule } from './shared/shared.module';

import { AppRoutingModule } from './app-routing.module';

// NG Translate
import { TranslateModule, TranslateLoader } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';

import { IncrementalEntryPointModule } from './incremental-entry-point/incremental-entry-point.module';
import { IncrementalModule } from './incremental/incremental.module'
import { IncrementalDialogModule } from './incremental-dialog/incremental-dialog.module';
import { ScrollableListModule } from './scrollable-list/scrollable-list.module';

import { AppComponent } from './app.component';
import { IncrementalCopyingModule } from './incremental-copying/incremental-copying.module';
import { BackupToOpticalMediaRoutingModule } from './backup-to-optical-media/backup-to-optical-media-routing.module';
import { AddMissigFilesToOpticalMediaColdStorageRoutingModule } from './add-missing-files-to-optical-media-cold-storage/add-missing-files-to-optical-media-cold-storage-routing.module';
import { MainMenuRoutingModule } from './main-menu/main-menu-routing.module';
import { VerifyColdStorageIntegrityRoutingModule } from './verify-cold-storage-integrity/verify-cold-storage-integrity-routing.module';

import {MatIconModule} from '@angular/material/icon';
import {MatButtonModule} from '@angular/material/button';
import {MatToolbarModule} from '@angular/material/toolbar';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';


// AoT requires an exported function for factories
export function HttpLoaderFactory(http: HttpClient): TranslateHttpLoader {
  return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

@NgModule({
  declarations: [AppComponent],
  imports: [
    BrowserModule,
    BrowserAnimationsModule,
    FormsModule,
    HttpClientModule,
    CoreModule,
    SharedModule,
    IncrementalEntryPointModule,
    IncrementalModule,
    IncrementalDialogModule,
    ScrollableListModule,
    IncrementalCopyingModule,
    BackupToOpticalMediaRoutingModule,
    AddMissigFilesToOpticalMediaColdStorageRoutingModule,
    MainMenuRoutingModule,
    VerifyColdStorageIntegrityRoutingModule,
    AppRoutingModule,
    MatIconModule,
    MatButtonModule,
    MatToolbarModule,
    MatSnackBarModule,
    TranslateModule.forRoot({
      loader: {
        provide: TranslateLoader,
        useFactory: HttpLoaderFactory,
        deps: [HttpClient]
      }
    })
  ],
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule {}
