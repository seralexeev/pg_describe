import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase } from './database.ts';

type Described = {
  params: Array<{ type: number; nullable: boolean }>;
  rows: 'one' | 'maybe' | 'many';
  columns: Array<{
    name: string;
    nullable: boolean;
    elementNullable?: boolean;
  }>;
};

let db: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ pool: db, drop } = await createTestDatabase());
  await db.query(`
      CREATE EXTENSION pg_describe;
      CREATE EXTENSION IF NOT EXISTS citext;
      CREATE SCHEMA fx;
      CREATE TYPE fx.kind AS ENUM ('shop', 'pos');
      CREATE TABLE fx.u (id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text, e varchar(3));
      CREATE TABLE fx.d (
        id uuid PRIMARY KEY,
        owner uuid NOT NULL REFERENCES fx.u,
        title text NOT NULL,
        kind fx.kind NOT NULL,
        store_id text,
        tags text[] NOT NULL,
        n int8 NOT NULL,
        deleted_at timestamptz,
        UNIQUE (owner, title),
        CHECK (kind <> 'shop' OR store_id IS NOT NULL)
      );
      CREATE UNIQUE INDEX d_live_title ON fx.d (title) WHERE deleted_at IS NULL;
      CREATE FUNCTION fx.skip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE FUNCTION fx.keep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TABLE fx.t (id uuid PRIMARY KEY);
      CREATE TRIGGER t_skip BEFORE INSERT ON fx.t FOR EACH ROW EXECUTE FUNCTION fx.skip();
      CREATE TRIGGER u_keep BEFORE INSERT OR UPDATE ON fx.u FOR EACH ROW EXECUTE FUNCTION fx.keep();
      CREATE FUNCTION fx.label(title text, n int8) RETURNS text LANGUAGE sql STABLE
        AS $$ SELECT CASE WHEN n > 0 THEN title ELSE 'none' END $$;
      CREATE FUNCTION fx.strict_label(name text) RETURNS text LANGUAGE sql STABLE STRICT
        AS $$ SELECT coalesce(name, 'none') $$;
    `);
});

afterAll(async () => {
  await drop();
});

const describeSql = async (sql: string) => {
  const { rows } = await db.query<{ d: Described }>('SELECT pg_describe($1)::json AS d', [sql]);
  return rows[0]!.d;
};

describe('pg_describe', () => {
  describe('row count', () => {
    it.each([
      ['the primary key', 'SELECT id FROM fx.d WHERE id = $1', 'maybe'],
      [
        'a composite unique key',
        'SELECT id FROM fx.d WHERE owner = $1 AND title = $2',
        'maybe',
      ],
      [
        'a partial unique index whose predicate holds',
        'SELECT id FROM fx.d WHERE title = $1 AND deleted_at IS NULL',
        'maybe',
      ],
      [
        'a partial unique index whose predicate is open',
        'SELECT id FROM fx.d WHERE title = $1',
        'many',
      ],
      [
        'a key through an inner join',
        'SELECT u.email FROM fx.d JOIN fx.u ON u.id = d.owner WHERE d.id = $1',
        'maybe',
      ],
      [
        'a key on the outer side of a left join',
        'SELECT u.email FROM fx.d LEFT JOIN fx.u ON u.id = d.owner WHERE d.id = $1',
        'maybe',
      ],
      [
        'a key only in a left join condition',
        'SELECT u.email FROM fx.d LEFT JOIN fx.u ON u.id = d.owner AND d.id = $1',
        'many',
      ],
      [
        'a key cast to text',
        'SELECT id FROM fx.d WHERE id::text = $1',
        'maybe',
      ],
      [
        'a key compared as citext',
        "SELECT id FROM fx.u WHERE email::citext = 'a'",
        'many',
      ],
      ['a having clause', 'SELECT 1 AS v HAVING false', 'maybe'],
      [
        'a fractional limit',
        'SELECT id FROM fx.d ORDER BY n LIMIT 1.5',
        'many',
      ],
      [
        'a key under a function',
        'SELECT id FROM fx.u WHERE lower(email) = $1',
        'many',
      ],
      [
        'a key in a disjunction',
        'SELECT id FROM fx.d WHERE id = $1 OR title = $2',
        'many',
      ],
      [
        'a key matched against an array',
        'SELECT id FROM fx.d WHERE id = ANY($1)',
        'many',
      ],
      [
        'a key compared to a volatile value',
        'SELECT id FROM fx.d WHERE id = gen_random_uuid()',
        'many',
      ],
      ['an aggregate without grouping', 'SELECT count(*) FROM fx.d', 'one'],
      [
        'an aggregate with grouping',
        'SELECT owner, count(*) FROM fx.d GROUP BY owner',
        'many',
      ],
      ['a select without from', 'SELECT now() AS now', 'one'],
      ['a constant limit', 'SELECT id FROM fx.d ORDER BY n LIMIT 1', 'maybe'],
      ['a parameter limit', 'SELECT id FROM fx.d LIMIT $1', 'many'],
      [
        'a limit with ties',
        'SELECT id FROM fx.d ORDER BY n FETCH FIRST 1 ROWS WITH TIES',
        'many',
      ],
      [
        'a keyed lateral subquery',
        'SELECT d.id, x.email FROM fx.d LEFT JOIN LATERAL (SELECT email FROM fx.u WHERE u.id = d.owner LIMIT 1) x ON TRUE WHERE d.id = $1',
        'maybe',
      ],
      [
        'a keyed cte',
        'WITH x AS (SELECT owner FROM fx.d WHERE id = $1) SELECT u.email FROM x JOIN fx.u ON u.id = x.owner',
        'maybe',
      ],
      [
        'a single-row insert',
        'INSERT INTO fx.u (id, email) VALUES ($1, $2) RETURNING id',
        'one',
      ],
      [
        'an insert from a one-row select',
        'INSERT INTO fx.u (id, email) SELECT g.id, $1 FROM (SELECT gen_random_uuid() AS id) g RETURNING id',
        'one',
      ],
      [
        'an insert from a filtered select',
        'INSERT INTO fx.u (id, email) SELECT id, title FROM fx.d WHERE id = $1 RETURNING id',
        'maybe',
      ],
      [
        'a multi-row insert',
        'INSERT INTO fx.u (id, email) VALUES ($1, $2), ($3, $4) RETURNING id',
        'many',
      ],
      [
        'an insert that may do nothing',
        'INSERT INTO fx.u (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
        'maybe',
      ],
      [
        'an upsert',
        'INSERT INTO fx.u (id, email) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET email = excluded.email RETURNING id',
        'one',
      ],
      [
        'a conditional upsert',
        'INSERT INTO fx.u (id, email) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET email = excluded.email WHERE u.name IS NULL RETURNING id',
        'maybe',
      ],
      [
        'an insert a before trigger may skip',
        'INSERT INTO fx.t (id) VALUES ($1) RETURNING id',
        'maybe',
      ],
      [
        'an insert under a trigger returning NEW',
        'INSERT INTO fx.u (id, email) VALUES ($1, $2) RETURNING id',
        'one',
      ],
      [
        'an update by key',
        'UPDATE fx.u SET name = $2 WHERE id = $1 RETURNING id',
        'maybe',
      ],
      [
        'an update by a non-key',
        'UPDATE fx.u SET name = $2 WHERE name = $1 RETURNING id',
        'many',
      ],
      [
        'a delete by key',
        'DELETE FROM fx.u WHERE email = $1 RETURNING id',
        'maybe',
      ],
    ])('bounds %s', async (_, sql, rows) => {
      expect((await describeSql(sql)).rows).toBe(rows);
    });
  });

  describe('column nullability', () => {
    it.each([
      ['a NOT NULL column', 'SELECT title FROM fx.d', false],
      ['a nullable column', 'SELECT name FROM fx.u', true],
      [
        'a column across a left join',
        'SELECT u.email FROM fx.d LEFT JOIN fx.u ON u.id = d.owner',
        true,
      ],
      [
        'a nullable column the filter rejects NULL for',
        'SELECT name FROM fx.u WHERE name = $1',
        false,
      ],
      [
        'a column a CHECK pins under the filter',
        "SELECT store_id FROM fx.d WHERE kind = 'shop'",
        false,
      ],
      [
        'a column a CHECK leaves open',
        "SELECT store_id FROM fx.d WHERE kind = 'pos'",
        true,
      ],
      ['count', 'SELECT count(*) AS c FROM fx.d', false],
      ['max without rows', 'SELECT max(n) AS m FROM fx.d', true],
      [
        'max under grouping',
        'SELECT max(n) AS m FROM fx.d GROUP BY owner',
        false,
      ],
      [
        'max of a nullable column under grouping',
        'SELECT max(name) AS m FROM fx.u GROUP BY email',
        true,
      ],
      [
        'sum under a rollup',
        'SELECT sum(n) AS s FROM fx.d GROUP BY ROLLUP (owner)',
        true,
      ],
      [
        'array_agg with a filter under grouping',
        'SELECT array_agg(title) FILTER (WHERE n > 1) AS a FROM fx.d GROUP BY owner',
        true,
      ],
      [
        'a statistical aggregate under grouping',
        'SELECT stddev(n) AS s FROM fx.d GROUP BY owner',
        true,
      ],
      [
        'array_agg under grouping',
        'SELECT array_agg(name) AS a FROM fx.u GROUP BY email',
        false,
      ],
      [
        'a keyed scalar subquery',
        'SELECT (SELECT title FROM fx.d WHERE d.id = u.id) AS t FROM fx.u',
        true,
      ],
      [
        'a strict function over non-null input',
        "SELECT title || '!' AS t FROM fx.d",
        false,
      ],
      [
        'a lookup that can miss',
        "SELECT (tags)[1] AS t, jsonb_build_object('a', 1) ->> 'b' AS j FROM fx.d",
        true,
      ],
      [
        'a SQL-syntax function that can miss',
        "SELECT substring(title FROM 'x')::varchar AS s FROM fx.d",
        true,
      ],
      ['a set-returning function', 'SELECT unnest(tags) AS t FROM fx.d', true],
      [
        'a named argument',
        'SELECT fx.label(n => n, title => name) AS l FROM fx.d JOIN fx.u ON u.id = d.owner',
        true,
      ],
      [
        'a sql function body',
        'SELECT fx.label(title, n) AS l FROM fx.d',
        false,
      ],
      [
        'a strict sql function over a nullable argument',
        'SELECT fx.strict_label(name) AS l FROM fx.u',
        true,
      ],
      [
        'old in an upsert',
        'INSERT INTO fx.u (id, email) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET email = excluded.email RETURNING old.email AS previous',
        true,
      ],
    ])('types %s', async (_, sql, nullable) => {
      expect((await describeSql(sql)).columns[0]!.nullable).toBe(nullable);
    });
  });

  describe('array elements', () => {
    it.each([
      ['a stored array', 'SELECT tags FROM fx.d', false],
      [
        'array_agg over a nullable column',
        'SELECT array_agg(name) AS a FROM fx.u',
        true,
      ],
      [
        'array_agg filtered to non-null',
        'SELECT array_agg(name) FILTER (WHERE name IS NOT NULL) AS a FROM fx.u',
        false,
      ],
      [
        'array_agg over an outer join',
        'SELECT array_agg(u.email) AS a FROM fx.d LEFT JOIN fx.u ON u.id = d.owner',
        true,
      ],
      [
        'unnest of a stored array',
        'SELECT array_agg(t) AS a FROM fx.d, unnest(tags) AS t',
        false,
      ],
      [
        'a stored array through a cte',
        'WITH x AS (SELECT tags FROM fx.d) SELECT tags FROM x',
        false,
      ],
      [
        'a stored array through a join alias',
        'SELECT tags FROM fx.d JOIN fx.u USING (id)',
        false,
      ],
      ['a nested array', 'SELECT ARRAY[ARRAY[1, NULL]] AS a', true],
      [
        'an array through a union',
        'SELECT a FROM (SELECT ARRAY[1] AS a UNION ALL SELECT ARRAY[NULL::int]) s',
        true,
      ],
    ])('types %s', async (_, sql, elementNullable) => {
      expect((await describeSql(sql)).columns[0]!.elementNullable).toBe(elementNullable);
    });
  });

  describe('parameters', () => {
    it.each([
      ['compared in a filter', 'SELECT id FROM fx.u WHERE email = $1', false],
      [
        'inserted into a nullable column',
        'INSERT INTO fx.u (id, email, name) VALUES ($1, $2, $3)',
        [false, false, true],
      ],
      [
        'inside COALESCE',
        'SELECT id FROM fx.u WHERE name = COALESCE($1, email)',
        true,
      ],
      [
        'assigned through a length coercion',
        'UPDATE fx.u SET e = $1 WHERE id = $2',
        [true, false],
      ],
      [
        'declared nullable in the filter',
        'SELECT id FROM fx.u WHERE $1::text IS NOT NULL AND email = $1',
        true,
      ],
    ])('types a parameter %s', async (_, sql, nullable) => {
      const { params } = await describeSql(sql);
      expect(params.map((p) => p.nullable)).toEqual(
        Array.isArray(nullable) ? nullable : [nullable],
      );
    });
  });
});
