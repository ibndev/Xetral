import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ServerResponse } from 'node:http';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

/**
 * The adapter is constructed explicitly rather than left to NestFactory's lazy
 * `require('@nestjs/platform-express')`. That lazy load fails under an ESM
 * loader with a message about the package being "missing" even though it is
 * installed, which is a genuinely confusing way to lose an afternoon.
 */
async function bootstrap(): Promise<void> {
  // Loaded before anything else so a missing secret stops the process here,
  // with a message naming the variable, rather than at the first request.
  const config = loadConfig(process.env);

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({ config }),
    new ExpressAdapter(),
    // Keeps the exact bytes of every request body. Webhook signatures cover
    // what the provider sent, and a body round-tripped through parse and
    // stringify fails verification in a way that looks like a wrong secret.
    { rawBody: true },
  );

  // A CEILING ON REQUEST BODIES.
  //
  // Express defaults to 100kb, which is already sane, but `rawBody: true`
  // means every request is buffered in full before any handler sees it — so
  // the limit is what stands between one process and a stream of 50MB bodies
  // from an unauthenticated caller. Nothing this API accepts is close to
  // 64kb: the largest is a KYC submission, which is a handful of text fields.
  //
  // Set explicitly rather than left to the default, because the default is a
  // property of a dependency and this is a decision about the service.
  app.useBodyParser('json', { limit: '64kb' });
  app.useBodyParser('urlencoded', { limit: '64kb', extended: false });

  // Without this, req.ip is the proxy's address and per-IP rate limiting
  // throttles every customer through one bucket. With it set too high, a client
  // can forge X-Forwarded-For and dodge the limit entirely — which is why the
  // hop count is configuration rather than a blanket `true`.
  app.set('trust proxy', config.trustProxyHops);

  /*
   * Response headers, on every answer this API gives.
   *
   * The web app sets its own in middleware.ts, with a per-request CSP nonce.
   * These are the API's, and it needs its own set because it is a separate
   * origin that a browser can be pointed at directly — an error page or a
   * JSON body rendered as HTML is the whole of an XSS on this host.
   *
   * `X-Powered-By` goes because announcing the framework and version to
   * everyone is free reconnaissance for whoever is scanning for the next
   * Express advisory.
   */
  app.disable('x-powered-by');
  app.use((_request: unknown, response: ServerResponse, next: () => void) => {
    // Never let a browser guess that a JSON body is HTML.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // This API renders nothing and should never be in a frame.
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    // Referrers leak account and transaction ids in paths to whatever a
    // customer navigates to next.
    response.setHeader('Referrer-Policy', 'no-referrer');
    // Every response here is about one customer's money. A shared cache
    // holding one is a shared cache serving it to somebody else.
    response.setHeader('Cache-Control', 'no-store');
    /*
     * HSTS, and it is set HERE rather than left to Cloudflare.
     *
     * The web app has sent this since it was written and the API did not,
     * which looked harmless because both sit behind the same edge. They do not
     * have the same clients: `apps/mobile` talks to this origin DIRECTLY, so
     * the browser-side protection the web app enjoys was never reaching the
     * clients that hold a customer's transaction PIN in a Keychain.
     *
     * And relying on the edge means a direct hit to the origin, or an edge
     * rule somebody changes, silently removes it. A security header that only
     * exists because of a setting in another system is a header nobody owns.
     *
     * Two years with `includeSubDomains`, matching what apps/web sends.
     * Browsers ignore it entirely over plain HTTP, so it costs nothing in
     * development.
     */
    response.setHeader(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
    next();
  });

  // Without this Nest never calls onApplicationShutdown, and the Redis
  // connection is left for the runtime to tear down on SIGTERM.
  app.enableShutdownHooks();

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  new Logger('bootstrap').log(`xetral api listening on ${port}`);
}

await bootstrap();
