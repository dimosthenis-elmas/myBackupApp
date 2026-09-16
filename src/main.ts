import { enableProdMode } from '@angular/core';
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';
import { APP_CONFIG } from './environments/environment';
import { appendLogLine, formatLogArg, reportRendererError, splitErrorArgs } from './app/shared/utils/error-log';

if (APP_CONFIG.production) {
  enableProdMode();
}

// Installed before Angular even starts bootstrapping, so it covers every console call in the app's own code -
// not just ones Angular's zone.js catches as an actual uncaught exception/rejection (GlobalErrorHandler,
// provided in app.module.ts, funnels those through this same console.error wrapper by calling console.error
// itself rather than reporting separately - see that file's own comment on why).
//
// All three levels are logged identically, in full technical detail, to logs.txt (same as main.ts's and
// worker.ts's own copies of this - see logging.ts). console.error ADDITIONALLY interrupts the user with a
// dialog, showing only a plain-language summary (see splitErrorArgs) - error vs warn is therefore a real
// severity call at each call site (does the user need to know about and acknowledge this?), not just style.
const originalConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };

console.log = (...args: unknown[]) => {
  originalConsole.log(...args);
  appendLogLine('LOG', args.map(formatLogArg).join(' '));
};

console.warn = (...args: unknown[]) => {
  originalConsole.warn(...args);
  appendLogLine('WARN', args.map(formatLogArg).join(' '));
};

console.error = (...args: unknown[]) => {
  originalConsole.error(...args);
  try {
    appendLogLine('ERROR', args.map(formatLogArg).join(' '));
    reportRendererError(splitErrorArgs(args));
  } catch {
    // Logging/reporting must never be able to crash the app - if this fails there is nowhere left to report it.
  }
};

platformBrowserDynamic()
  .bootstrapModule(AppModule, {
    preserveWhitespaces: false
  })
  .catch(err => {
    // console.error alone is not enough here specifically: it still logs to logs.txt fine (appendLogLine only
    // needs window.electronAPI, not Angular), but the dialog it also queues (reportRendererError) would never
    // actually show - ErrorReporterService is what registers the handler that flushes that queue, and Angular
    // failing to bootstrap means it, and every other component/service, never gets constructed at all. A plain
    // window.alert() is the only UI this can still reach in that case.
    console.error(err);
    window.alert('The app failed to start. Technical details have been saved to the log file.');
  });
