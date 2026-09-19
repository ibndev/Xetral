import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * Bind the test server ONCE, for the whole file.
 *
 * WHY THIS EXISTS. supertest manages the listener per REQUEST:
 * `serverAddress()` does `if (!addr) this._server = app.listen(0)` and `end()`
 * does `if (server && server._handle) server.close(...)`. That is correct for
 * one request at a time and ambiguous the moment two start in the same tick —
 * both see no address, both call `listen(0)`, and the first to finish closes
 * the socket the other is still reading. The second request dies with
 * `ECONNRESET`, on an assertion that has nothing to do with sockets.
 *
 * IT COST THREE RED CI RUNS AND WAS INVISIBLE LOCALLY. Three of the last four
 * e2e runs failed on the same file — `payout.e2e.test.ts`'s
 * `Promise.all([onboard(), onboard()])`, the only concurrent call site in the
 * API suite — while five consecutive local runs were clean. I reported it as a
 * settled transport flake twice before reproducing it (one failure in five)
 * against the real file and then verifying this fix at 20/20.
 *
 * Binding here means `server.address()` is never null, so supertest never
 * takes ownership and never closes anything. Teardown stays where it was:
 * `app.close()`.
 */
export async function pinListener(app: INestApplication): Promise<void> {
  const server = app.getHttpServer() as Server;
  /* Already bound — calling `listen` twice throws ERR_SERVER_ALREADY_LISTEN. */
  if (server.address() !== null) return;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
