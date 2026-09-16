import { ErrorHandler, Injectable } from '@angular/core';

/** Catches every uncaught exception/promise rejection Angular's zone.js sees (which, since zone.js patches the
 *  global async APIs, is effectively all app code) and routes it through console.error - not by calling
 *  error-log.ts's reportRendererError directly, since src/main.ts's console.error wrapper already does exactly
 *  that. Routing through console.error here (rather than duplicating that call) is what keeps this a single
 *  path: every renderer-side error - console.error calls throughout the app's own code, and whatever Angular
 *  catches here - ends up logged and dialog'd exactly once. */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    console.error('Something unexpected went wrong in the app.', error);
  }
}
