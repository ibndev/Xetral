import { randomBytes } from 'node:crypto';
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
 *
 * EVERY 5xx CARRIES A REFERENCE, and that is what makes one reportable.
 *
 * THE FAILURE THIS EXISTS FOR. The body of a 500 is `{ error:
 * 'internal_error' }` and nothing else — correct, because a body that
 * described the exception would be an information leak added by the thing
 * meant to help. The consequence is that "Something went wrong. Please try
 * again." is the whole of what anybody can see, on the screen AND in the
 * report that reaches whoever could fix it. Two unrelated endpoints failing
 * for two unrelated reasons produce the identical sentence, so the first
 * question — WHICH failure is this? — cannot be answered at all, and the
 * available next step is to guess.
 *
 * A reference is six hex characters minted here, put in the body, and written
 * into the same log line as the exception. It says nothing about our tables,
 * our providers or our schema, so it is safe on a customer's screen; and it
 * turns an unsearchable sentence into one `grep` against the deployment's
 * logs. Not an id anything stores: it identifies THIS response, and
 * `error_events` already fingerprints the underlying bug.
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

    // Only for a 5xx. A 4xx already names itself — `invalid_pin` is not a
    // mystery anybody needs a reference to look up — and minting one for every
    // wrong PIN would put a meaningless token on a screen that is working.
    const reference = status >= 500 ? randomBytes(3).toString('hex') : undefined;

    if (status >= 500) {
      /*
       * THE CAUSE, WHERE THERE IS ONE, AND THIS IS LOAD-BEARING.
       *
       * A service that catches an unclassifiable failure and rethrows it as
       * `ServiceUnavailableException` so the customer gets a code their app
       * understands is doing the right thing — and it would destroy the only
       * record of what actually happened, because what reaches here is then a
       * Nest exception whose message is "Service Unavailable". `error_events`
       * would fill with rows that say nothing, which is the failure this
       * whole area exists to end.
       *
       * So the ORIGINAL is preferred whenever a handler passed one through as
       * `cause`. The wrapper's own name is kept alongside it, because "which
       * layer decided this was unavailable" is worth a word.
       */
      const cause = exception instanceof Error ? exception.cause : undefined;
      const message =
        cause instanceof Error
          ? `${exception instanceof Error ? exception.name : 'Error'} <- ${cause.name}: ${cause.message}`
          : exception instanceof Error
            ? `${exception.name}: ${exception.message}`
            : String(exception);

      // The reference FIRST, because this is the line somebody greps for with
      // six characters read off a screen or pasted into a report.
      this.#logger.error(
        `[${reference}] ${request.method} ${routeOf(request)} -> ${status}: ${message}`,
      );

      // The stack too, and only for a 5xx. A 500 whose log line is one
      // sentence tells you a query failed and never which query; this is the
      // half that says where. It is a log, not a response body — nothing here
      // reaches a caller.
      // The CAUSE's stack, where there is one: the wrapper's stack ends at
      // the catch that made it and says nothing about where the failure was.
      const stack = cause instanceof Error ? cause.stack : (exception as Error).stack;
      if (typeof stack === 'string') {
        this.#logger.error(`[${reference}] ${stack}`);
      }

      // NOT awaited. An exception filter that waits on a database write adds
      // the recorder's latency to every failed request, and if the database is
      // what broke it adds a timeout as well. `record` never rejects, so
      // nothing is left unhandled.
      void this.errors.record({
        message,
        route: routeOf(request),
        statusCode: status,
        // The third place the reference goes, and the one that makes it
        // answerable: the number read off a screen finds the row carrying the
        // exception's own sentence.
        ...(reference === undefined ? {} : { reference }),
      });
    }

    // The response is unchanged from what Nest would have sent. This filter
    // observes; it does not decide what a caller sees, and a 500 body that
    // started describing the exception would be an information leak added by
    // the thing meant to help.
    if (response.headersSent) return;

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      // A 4xx passes through untouched. A 5xx gains the reference — merged
      // into an object body, and replacing a string one, because Nest's
      // default `getResponse()` for a bare `InternalServerErrorException` is
      // a string and a caller parsing `{ error }` learns nothing from it.
      if (reference === undefined) {
        response.status(status).json(body);
        return;
      }
      response
        .status(status)
        .json(
          typeof body === 'object' && body !== null
            ? { ...(body as Record<string, unknown>), reference }
            : { error: 'internal_error', reference },
        );
      return;
    }
    response.status(500).json({ error: 'internal_error', reference });
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
