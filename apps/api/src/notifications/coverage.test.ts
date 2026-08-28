import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every notification kind is actually enqueued by something.
 *
 * THE FAILURE THIS EXISTS FOR is the same shape as the dead kill switches: a
 * template that renders beautifully, has unit tests, appears in the enum, and
 * that no line of code ever asks for. Nothing in the type system catches it —
 * an unused branch of a union is just an unused branch — and it is invisible
 * in review because the template is right there, looking finished.
 *
 * It matters more here than for most dead code, because the whole point of
 * these messages is to be the thing that reaches a customer when something is
 * wrong. A `new_device` template nobody enqueues is an account-takeover alert
 * that will never fire, and the first person to discover it will be somebody
 * whose account was taken over.
 */

const SRC = join(new URL('.', import.meta.url).pathname, '..');

function walk(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/** The kinds declared by the union in templates.ts. */
function declaredKinds(): readonly string[] {
  const source = readFileSync(join(SRC, 'notifications', 'templates.ts'), 'utf8');
  // Read off CLASS_OF rather than the union: it is a Record keyed by every
  // kind, so the compiler already fails the build if the two disagree, and one
  // regex over an object literal is far less brittle than one over a
  // multi-line discriminated union.
  const block = /const CLASS_OF: Record<NotificationKind, NotificationClass> = \{([^}]*)\}/s.exec(
    source,
  );
  expect(block, 'CLASS_OF was renamed or reshaped; this scanner needs updating').not.toBeNull();

  return [...(block?.[1] ?? '').matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1] as string);
}

/** The kinds some service actually asks to send. */
function enqueuedKinds(): ReadonlyMap<string, readonly string[]> {
  const found = new Map<string, string[]>();

  for (const file of walk(SRC)) {
    // The templates themselves and the enqueue plumbing name every kind by
    // definition; only a CALLER counts as an enforcement point.
    if (file.endsWith(join('notifications', 'templates.ts'))) continue;
    if (file.endsWith(join('notifications', 'notification.service.ts'))) continue;
    if (file.endsWith(join('notifications', 'notification.worker.ts'))) continue;

    for (const match of readFileSync(file, 'utf8').matchAll(/kind:\s*'([a-z_]+)'/g)) {
      const name = match[1] as string;
      const at = found.get(name) ?? [];
      at.push(file.slice(SRC.length + 1));
      found.set(name, at);
    }
  }

  return found;
}

describe('notification coverage', () => {
  it('every declared kind is enqueued somewhere', () => {
    const enqueued = enqueuedKinds();
    const dead = declaredKinds()
      .filter((kind) => !enqueued.has(kind))
      .sort();

    expect(
      dead,
      'these messages have templates and will never be sent to anyone: ' + dead.join(', '),
    ).toEqual([]);
  });

  it('finds the call sites it is meant to be checking', () => {
    // A scanner whose regex stopped matching would report every kind as dead —
    // loud, and therefore fine. One that matched nothing while the first test
    // somehow passed would be silent. Pin the floor.
    const kinds = declaredKinds();
    expect(kinds.length).toBeGreaterThanOrEqual(8);
    expect([...enqueuedKinds().keys()].length).toBeGreaterThanOrEqual(kinds.length);
  });

  it('the alert a customer needs most is on the LOGIN path', () => {
    // Named specifically rather than left to the general check above. A
    // new-device alert enqueued from anywhere else — a background sweep, a
    // device-list read — would arrive too late to be the thing it is for.
    const at = enqueuedKinds().get('new_device') ?? [];
    expect(at.some((f) => f.includes('auth.service.ts'))).toBe(true);
  });

  it('the money receipts are on the paths that move money', () => {
    const enqueued = enqueuedKinds();
    expect(enqueued.get('transfer_sent')?.some((f) => f.includes('wallet'))).toBe(true);
    expect(enqueued.get('deposit_credited')?.some((f) => f.includes('funding'))).toBe(true);
    expect(enqueued.get('crypto_withdrawal_sent')?.some((f) => f.includes('crypto'))).toBe(true);
  });
});
