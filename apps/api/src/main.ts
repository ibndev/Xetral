import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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
  );

  // Without this, req.ip is the proxy's address and per-IP rate limiting
  // throttles every customer through one bucket. With it set too high, a client
  // can forge X-Forwarded-For and dodge the limit entirely — which is why the
  // hop count is configuration rather than a blanket `true`.
  app.set('trust proxy', config.trustProxyHops);

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  new Logger('bootstrap').log(`xetral api listening on ${port}`);
}

await bootstrap();
