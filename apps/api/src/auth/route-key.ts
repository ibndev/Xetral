import { RequestMethod } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { HttpMethod } from '@xetral/identity';

/**
 * Derives the policy key (`POST /v1/auth/login`) for the route being handled.
 *
 * Read from Nest's own route metadata rather than from the incoming URL, and
 * that choice is load-bearing. The URL is concrete — `/v1/cards/8823/freeze` —
 * while the policy is declared against the template. Matching on the URL would
 * mean either re-implementing path-pattern matching or declaring policies per
 * customer id, and the first of those is a place for a subtle mismatch between
 * what the router matched and what the policy checked.
 *
 * The metadata is exactly what the router itself used, so the two cannot
 * disagree.
 */

/**
 * The metadata keys Nest's router writes, declared here as literals rather than
 * imported from '@nestjs/common/constants'.
 *
 * That module has no `exports` entry and no extension-less ESM resolution, so
 * importing it works under vitest and fails at runtime with ERR_MODULE_NOT_FOUND
 * — a failure that only appears once the bundle is actually started, which is
 * the worst possible moment to find it.
 *
 * The values are stable ('path', 'method'), and `route-key.test.ts` asserts
 * these literals still equal what Nest exports. So a change on their side breaks
 * a test rather than a deploy.
 */
export const PATH_METADATA = 'path';
export const METHOD_METADATA = 'method';

const METHOD_NAMES: Partial<Record<RequestMethod, HttpMethod>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

export interface RouteKey {
  readonly method: HttpMethod;
  readonly path: string;
}

/** Joins a controller prefix and a handler path into one normalised path. */
export function buildRoutePath(controllerPath: string, handlerPath: string): string {
  const segments = [controllerPath, handlerPath]
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment !== '' && segment !== '.');

  return `/${segments.join('/')}`;
}

/**
 * Returns undefined when the route cannot be identified — a wildcard method,
 * or metadata Nest stopped emitting after an upgrade. The caller treats that
 * as a denial, because a route whose identity is unknown cannot have been
 * checked against a policy.
 */
export function routeKeyOf(context: ExecutionContext): RouteKey | undefined {
  const handler = context.getHandler();
  const controller = context.getClass();

  const method = METHOD_NAMES[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
  if (method === undefined) return undefined;

  const controllerPath: unknown = Reflect.getMetadata(PATH_METADATA, controller);
  const handlerPath: unknown = Reflect.getMetadata(PATH_METADATA, handler);
  if (typeof controllerPath !== 'string' || typeof handlerPath !== 'string') return undefined;

  return { method, path: buildRoutePath(controllerPath, handlerPath) };
}
