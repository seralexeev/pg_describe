import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, SERVER } from './database.ts';

const run = promisify(execFile);
const packageDir = path.join(import.meta.dirname, '..');
const tsc = path.join(packageDir, '../../node_modules/typescript/bin/tsc');
const cli = path.join(packageDir, 'dist/cli.js');
const project = path.join(import.meta.dirname, '.projects', randomBytes(4).toString('hex'));

const SCHEMA = 'CREATE TABLE notes (id int PRIMARY KEY, body text NOT NULL);\n';
const QUERIES = '/* @name addNote */\nINSERT INTO notes (id, body) VALUES (:id, :body);\n\n/* @name getNote */\nSELECT body FROM notes WHERE id = :id;\n';
const MAIN = `import pg from 'pg';
import { addNote, getNote } from './notes.sql';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await addNote(pool, { id: 1, body: 'hello' });
const note = await getNote(pool, { id: 1 });
console.log(note?.body);
await pool.end();
`;

const write = (file: string, content: string) => writeFileSync(path.join(project, file), content);

const outcome = async (command: string, args: string[], env: Record<string, string> = {}) =>
  await run(command, args, { cwd: project, env: { ...process.env, ...env } }).then(
    ({ stdout }) => ({ code: 0, output: stdout }),
    (error: { code: number; stdout: string; stderr: string }) => ({
      code: error.code,
      output: error.stdout + error.stderr,
    }),
  );

let app: pg.Pool;
let appUrl: string;
let drop: () => Promise<void>;

beforeAll(async () => {
  mkdirSync(path.join(project, 'db'), { recursive: true });
  write('db/schema.sql', SCHEMA);
  write('notes.sql', QUERIES);
  write('main.ts', MAIN);
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { module: 'nodenext', target: 'es2024', strict: true, noEmit: true, types: ['node'], skipLibCheck: true },
      contentMappers: [
        { package: 'pg-describe', extensions: ['.sql'], options: { database: SERVER, schema: 'db/*.sql' } },
      ],
      include: ['*.ts', '*.sql'],
    }),
  );
  write('package.json', '{ "type": "module" }');

  let name: string;
  ({ pool: app, drop, name } = await createTestDatabase());
  await app.query(SCHEMA);
  appUrl = new URL(`/${name}`, SERVER).toString();
});

afterAll(async () => {
  await drop();
  rmSync(project, { recursive: true, force: true });
});

describe('a project that imports a .sql file', () => {
  it('type-checks through the content mapper', async () => {
    expect(await outcome(process.execPath, [tsc, '--runExternalCode'])).toEqual({ code: 0, output: '' });
  });

  it('reports SQL and TypeScript errors at their source', async () => {
    write('notes.sql', QUERIES.replace('SELECT body', 'SELECT bdy'));
    write('wrong.ts', "import { addNote } from './notes.sql';\nexport const x: number = addNote;\n");
    try {
      const { code, output } = await outcome(process.execPath, [tsc, '--runExternalCode', '--pretty', 'false']);
      expect(code).not.toBe(0);
      expect(output).toContain('notes.sql(5,8): error pg-describe1002: column "bdy" does not exist');

      write('notes.sql', QUERIES);
      const second = await outcome(process.execPath, [tsc, '--runExternalCode', '--pretty', 'false']);
      expect(second.output).toMatch(/wrong\.ts\(2,14\): error TS2322/);
    } finally {
      write('notes.sql', QUERIES);
      rmSync(path.join(project, 'wrong.ts'));
    }
  });

  it('refuses to run from source without a lock entry and never describes', async () => {
    const { code, output } = await outcome(process.execPath, ['--import', 'pg-describe/register', 'main.ts'], {
      DATABASE_URL: appUrl,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("statement 'addNote' is not described");
    expect(existsSync(path.join(project, 'pg-describe.lock.json'))).toBe(false);
  });

  it('describes missing statements with the dev loader and runs', async () => {
    const result = await outcome(process.execPath, ['--import', 'pg-describe/register-dev', 'main.ts'], {
      DATABASE_URL: appUrl,
    });
    expect(result).toEqual({ code: 0, output: 'hello\n' });
  });

  it('runs from the lock alone once it is written', async () => {
    await app.query('TRUNCATE notes');
    const result = await outcome(process.execPath, ['--import', 'pg-describe/register', 'main.ts'], {
      DATABASE_URL: appUrl,
    });
    expect(result).toEqual({ code: 0, output: 'hello\n' });
  });

  it('runs from the lock without the schema files', async () => {
    await app.query('TRUNCATE notes');
    rmSync(path.join(project, 'db'), { recursive: true });
    try {
      const result = await outcome(process.execPath, ['--import', 'pg-describe/register', 'main.ts'], {
        DATABASE_URL: appUrl,
      });
      expect(result).toEqual({ code: 0, output: 'hello\n' });
    } finally {
      mkdirSync(path.join(project, 'db'));
      write('db/schema.sql', SCHEMA);
    }
  });

  it('fails the lock check once a query changes', async () => {
    expect((await outcome(process.execPath, [cli, 'lock', '--check'])).code).toBe(0);

    write('notes.sql', `${QUERIES}\n/* @name countNotes */\nSELECT count(*) AS total FROM notes;\n`);
    const stale = await outcome(process.execPath, [cli, 'lock', '--check']);
    expect(stale.code).toBe(1);
    expect(stale.output).toContain("out of date; run 'pg-describe lock'");

    expect((await outcome(process.execPath, [cli, 'lock'])).output).toBe('Described 3 statements in 1 files\n');
    expect((await outcome(process.execPath, [cli, 'lock', '--check'])).code).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(path.join(project, 'pg-describe.lock.json'), 'utf8')).statements)).toHaveLength(3);
  });
});
