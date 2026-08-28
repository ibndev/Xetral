import { Catch, HttpException, Inject, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorRecorder } from './error-recorder.service.js';

/**
 * The one place every unhandled failure passes through.
 *
 * WHAT IT RECORDS AND WHAT IT IGNORES, because the distinction is the
 * difference between a table somebody reads and a table somebody mutes.
 *
 * A 4xx is NOT an error. A rejected password, a wrong PIN, a malformed body,
 * an insufficient balance — those are the system working. Recording them would
 * bury the one row that matters under ten thousand rows that do not, and the
 * predictable end of that is nobody opening the page.
 *
 * A 5xx IS an error, always: it means a request the customer was entitled to
 * make did not work, and somebody has to know. So does anything that is not an
 * HttpException at all — a TypeError, a failed query, an unhandled rejection —
 * because reaching here means nothing in the codebase expected it.
 */
@Catch()
export class ErrorRecordingFilter implements ExceptionFilter {
  readonly #logger = new Logger('Unhandled');

  constructor(@Inject(ErrorRecorder) private readonly errors: ErrorRecorder) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const status = exception instanceof HttpException ? exception.getStatus() : 500;

    if (status >= 500) {
      const message =
        exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception);

      this.#logger.error(`${request.method} ${routeOf(request)} -> ${status}: ${message}`);

      // NOT awaited. An exception filter that waits on a database write adds
      // the recorder's latency to every failed request, and if the database is
      // what broke it adds a timeout as well. `record` never rejects, so
      // nothing is left unhandled.
      void this.errors.record({
        message,
        route: routeOf(request),
        statusCode: status,
      });
    }

    // The response is unchanged from what Nest would have sent. This filter
    // observes; it does not decide what a caller sees, and a 500 body that
    // started describing the exception would be an information leak added by
    // the thing meant to help.
    if (response.headersSent) return;

    if (exception instanceof HttpException) {
      response.status(status).json(exception.getResponse());
      return;
    }
    response.status(500).json({ error: 'internal_error' });
  }
}

/**
 * The route PATTERN, not the resolved path.
 *
 * `/v1/admin/users/:id` and never `/v1/admin/users/8814`. The resolved path
 * carries customer identifiers into a table that exists to be read by
 * everybody on call, and it would also give every customer their own
 * fingerprint — turning one bug into as many rows as it has victims.
 */
function routeOf(request: Request): string {
  const route = (request as { route?: { path?: unknown } }).route;
  if (route !== undefined && typeof route.path === 'string') return route.path;

  // No matched route: a 404, or a failure early enough that routing never
  // happened. The path itself would be attacker-controlled here, so it is
  // deliberately not recorded.
  return 'unmatched';
}
