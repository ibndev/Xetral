import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import pg from 'pg';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * EVERY SQL STATEMENT IN THE SERVER, PREPARED AGAINST THE MIGRATED SCHEMA.
 *
 * A SQL string is invisible to TypeScript, and a unit test with a fake pool
 * holds no opinion about one. This repo has shipped that fault repeatedly: a
 * freeze that wrote to a table called `sessions`, a card INSERT naming `$9`
 * against eight values — and, when this suite was written, two more that no
 * test reached: the admin customer page selected `devices.created_at` and
 * `devices.revoked_at` (neither exists, so its Devices panel was empty for
 * every customer) and `GET /v1/auth/devices` read `auth_sessions.expires_at`
 * (which does not exist, so it answered 500 to everybody).
 *
 * `PREPARE` parses and resolves every table, column, function and type
 * without executing anything, so it finds all of that in one pass. Each
 * statement is taken from the source by the TypeScript AST — every
 * `.query(...)` whose SQL is a literal, a conditional between literals, or a
 * template over module-level string constants — and prepared as the
 * APPLICATION's role, inside a transaction that is rolled back.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('this suite needs DATABASE_URL pointing at a migrated database');
}

const REPO = join(new URL('.', import.meta.url).pathname, '..', '..', '..');
const ROOTS = ['apps/api/src', 'packages/ledger/src', 'packages/identity/src', 'packages/providers/src'];

interface Statement {
  readonly where: string;
  readonly sql: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Module-level `const NAME = '...'` / `` `...` `` in one file. */
function constants(source: ts.SourceFile): Map<string, string> {
  const found = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || init === undefined) continue;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        found.set(declaration.name.text, init.text);
      }
    }
  }
  return found;
}

/** Every SQL text an argument can be, or undefined where it cannot be known statically. */
function texts(node: ts.Expression, consts: Map<string, string>): string[] | undefined {
  if (ts.isParenthesizedExpression(node)) return texts(node.expression, consts);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    const a = texts(node.whenTrue, consts);
    const b = texts(node.whenFalse, consts);
    return a !== undefined && b !== undefined ? [...a, ...b] : undefined;
  }
  if (ts.isTemplateExpression(node)) {
    let sql = node.head.text;
    for (const span of node.templateSpans) {
      if (!ts.isIdentifier(span.expression)) return undefined;
      const value = consts.get(span.expression.text);
      if (value === undefined) return undefined;
      sql += value + span.literal.text;
    }
    return [sql];
  }
  return undefined;
}

function statements(): Statement[] {
  const found: Statement[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(REPO, root))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const consts = constants(source);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'query' &&
          node.arguments[0] !== undefined
        ) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          for (const sql of texts(node.arguments[0], consts) ?? []) {
            if (/^\s*(select|insert|update|delete|with)\b/i.test(sql)) {
              found.push({ where: `${relative(REPO, file)}:${line}`, sql });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found;
}

let client: pg.Client;

beforeAll(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe('the SQL the server sends', () => {
  const all = statements();

  it('finds the statements to check', () => {
    // A walker that silently found nothing would pass everything below.
    expect(all.length).toBeGreaterThan(400);
  });

  it('every statement resolves against the migrated schema', async () => {
    const failures: string[] = [];
    for (const [index, statement] of all.entries()) {
      try {
        await client.query('BEGIN');
        await client.query(`PREPARE audit_${index} AS ${statement.sql}`);
      } catch (error) {
        failures.push(`${statement.where}: ${(error as Error).message}`);
      } finally {
        await client.query('ROLLBACK');
      }
    }
    expect(failures).toEqual([]);
  });
});
