import { describe, expect, it } from 'vitest';

import { parseSqlFile, sourceSpan } from '../src/sql_file.ts';

const at = (source: string, span: { start: number; length: number }) =>
  source.slice(span.start, span.start + span.length);

describe('parseSqlFile', () => {
  it('numbers each distinct parameter once and points at its first use', () => {
    const source = '/* @name q */\nSELECT * FROM t WHERE a = :a OR b = :b OR c = :a;\n';
    const [statement] = parseSqlFile(source).statements;
    expect(statement!.text).toBe('SELECT * FROM t WHERE a = $1 OR b = $2 OR c = $1');
    expect(statement!.params).toEqual(['a', 'b']);
    expect(statement!.paramSpans.map((s) => s.start)).toEqual([
      source.indexOf(':a') + 1,
      source.indexOf(':b') + 1,
    ]);
  });

  it.each([
    ['a cast', "SELECT '1'::int AS x"],
    ['a string', "SELECT ':a' AS x"],
    ['an escape string', "SELECT E'\\':a' AS x"],
    ['a quoted identifier', 'SELECT 1 AS ":a"'],
    ['a line comment', 'SELECT 1 AS x -- :a'],
    ['a block comment', 'SELECT 1 /* :a */ AS x'],
    ['a dollar-quoted body', 'SELECT $f$ :a $f$ AS x'],
  ])('leaves a colon inside %s alone', (_, sql) => {
    const [statement] = parseSqlFile(`/* @name q */\n${sql}`).statements;
    expect(statement!.params).toEqual([]);
  });

  it('reports a duplicate name and skips that statement', () => {
    const source = '/* @name q */ SELECT 1 AS a;\n/* @name q */ SELECT 2 AS a;\n/* @name r */ SELECT 3 AS a;';
    const { statements, errors } = parseSqlFile(source);
    expect(statements.map((s) => s.text)).toEqual(['SELECT 1 AS a', 'SELECT 3 AS a']);
    expect(errors.map((e) => [e.message, e.start])).toEqual([
      ["Duplicate statement name 'q'.", source.lastIndexOf('q */')],
    ]);
  });

  it('reports SQL before the first annotation', () => {
    const { errors } = parseSqlFile('-- header\nSELECT 1;\n/* @name q */ SELECT 2 AS a;');
    expect(errors.map((e) => e.message)).toEqual(['SQL before the first @name annotation.']);
  });

  it('treats a file without annotations as no queries', () => {
    expect(parseSqlFile('CREATE TABLE t (id int);')).toEqual({ statements: [], errors: [] });
  });
});

describe('sourceSpan', () => {
  it('maps a Postgres error position back to the word in the file', () => {
    const source = '/* @name q */\nSELECT id FROM t\nWHERE a = :value AND nope = 1;';
    const [statement] = parseSqlFile(source).statements;
    const position = statement!.text.indexOf('nope') + 1;
    expect(at(source, sourceSpan(statement!, position))).toBe('nope');
  });

  it('counts the position in code points', () => {
    const source = "/* @name q */\nSELECT '😀' AS e, nope";
    const [statement] = parseSqlFile(source).statements;
    const position = [...statement!.text].indexOf('n') + 1;
    expect(at(source, sourceSpan(statement!, position))).toBe('nope');
  });

  it('falls back to the statement name without a position', () => {
    const source = '/* @name lookup */\nSELECT 1';
    const [statement] = parseSqlFile(source).statements;
    expect(at(source, sourceSpan(statement!, undefined))).toBe('lookup');
  });
});
