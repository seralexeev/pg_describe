import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compileSqlFile, DiagnosticCode } from '../src/codegen.ts';
import { resolveConfig } from '../src/config.ts';
import { Describer } from '../src/database.ts';
import { SERVER } from './database.ts';

const config = resolveConfig(path.join(import.meta.dirname, 'fixtures'), {
  database: SERVER,
  schema: 'schema.sql',
  types: { int4: 'bigint' },
});

let describer: Describer;

beforeAll(async () => {
  describer = await Describer.open(config);
});

afterAll(async () => {
  await describer.close();
});

const compile = async (source: string) => await compileSqlFile(config, describer, source);

const at = (source: string, start: number, length: number) => source.slice(start, start + length);

describe('compileSqlFile', () => {
  it('maps every span to the same text in the original file', async () => {
    const source = '/* @name byKind */\nSELECT id FROM items WHERE kind = :kind AND title = :title;\n';
    const { declaration, mappings } = await compile(source);
    expect(mappings.map(([vs, vl, os, ol]) => [at(declaration, vs, vl), at(source, os, ol)])).toEqual([
      ['byKind', 'byKind'],
      ['kind', 'kind'],
      ['title', 'title'],
    ]);
  });

  it('reports a describe failure at the offending word', async () => {
    const source = '/* @name q */\nSELECT id, nope FROM items;';
    const { diagnostics } = await compile(source);
    expect(diagnostics.map((d) => [d.code, at(source, d.start, d.length), d.message])).toEqual([
      [DiagnosticCode.Describe, 'nope', 'column "nope" does not exist'],
    ]);
  });

  it.each([
    ['an unnamed column', 'SELECT 1 FROM items'],
    ['a duplicate column', 'SELECT id, title AS id FROM items'],
    ['columns that collide once camelCased', 'SELECT 1 AS a_b, 2 AS "aB" FROM items'],
  ])('rejects %s', async (_, sql) => {
    const source = `/* @name q */\n${sql}`;
    const { diagnostics, statements } = await compile(source);
    expect(diagnostics.map((d) => [d.code, at(source, d.start, d.length)])).toEqual([[DiagnosticCode.Columns, 'q']]);
    expect(statements[0]!.entry).toBeUndefined();
  });

  it('records what the runtime needs to shape results', async () => {
    const { statements } = await compile(
      [
        '/* @name insert */ INSERT INTO items (id, title, kind, payload) VALUES (:id, :title, :kind, :payload);',
        '/* @name one */ SELECT id AS item_id FROM items WHERE id = :id;',
      ].join('\n'),
    );
    expect(statements.map((s) => s.entry)).toEqual([
      { rows: 'none', columns: [], json: ['payload'] },
      { rows: 'maybe', columns: ['itemId'] },
    ]);
  });

  it('applies type overrides by Postgres type name', async () => {
    const { declaration } = await compile('/* @name q */ SELECT id FROM items WHERE id = :id;');
    expect(declaration).toContain('SqlQuery<{ id: bigint; }, { id: bigint }, "maybe">');
  });
});
