import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

import { type Config, schemaFiles, schemaIdentity } from './config.ts';

export type Described = {
  params: Array<{ type: number; nullable: boolean }>;
  rows: 'one' | 'maybe' | 'many';
  columns: Array<{
    name: string;
    type: number;
    nullable: boolean;
    elementNullable?: boolean;
  }>;
};

export type DescribeResult =
  | { ok: true; described: Described }
  | { ok: false; message: string; position: number | undefined };

export type PgType = {
  oid: number;
  name: string;
  elem: number;
  array: boolean;
  labels: string[] | null;
};

const CATALOG_IDENTITY = `
  SELECT md5(coalesce(string_agg(x, E'\\n' ORDER BY x), '')) AS identity
  FROM (
    SELECT a.attrelid::regclass || '.' || a.attname || ' ' || a.atttypid || ' ' || a.attnotnull AS x
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace >= 16384 AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT conrelid::regclass || ' ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace >= 16384
    UNION ALL
    SELECT pg_get_indexdef(indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace >= 16384
    UNION ALL
    SELECT c.oid::regclass || ' ' || pg_get_viewdef(c.oid) FROM pg_class c WHERE c.relkind IN ('v', 'm') AND c.relnamespace >= 16384
    UNION ALL
    SELECT p.oid::regprocedure || ' ' || p.provolatile || p.proisstrict || ' ' || p.prosrc FROM pg_proc p WHERE p.pronamespace >= 16384
    UNION ALL
    SELECT enumtypid::regtype || ' ' || enumlabel FROM pg_enum
  ) s
`;

const TYPES = `
  SELECT
    t.oid::int AS oid,
    t.typname AS name,
    t.typelem::int AS elem,
    t.typcategory = 'A' AS array,
    (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels
  FROM pg_type t
`;

export class Describer {
  public readonly identity;
  public readonly types;
  private readonly pool;

  private constructor(pool: pg.Pool, identity: string, types: Map<number, PgType>) {
    this.pool = pool;
    this.identity = identity;
    this.types = types;
  }

  public static async open(config: Config) {
    if (config.database == null) {
      throw new Error(
        "pg-describe needs a database: set the 'database' option of the content mapper or PG_DESCRIBE_URL",
      );
    }
    const files = schemaFiles(config);
    const url = files.length > 0 ? await schemaDatabase(config.database, files) : config.database;
    const pool = new pg.Pool({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 5000,
      application_name: 'pg-describe',
    });
    try {
      if (files.length === 0) {
        await pool.query('CREATE EXTENSION IF NOT EXISTS pg_describe');
      }
      const identity =
        files.length > 0
          ? schemaIdentity(files)
          : (await pool.query<{ identity: string }>(CATALOG_IDENTITY)).rows[0]!.identity;
      const { rows } = await pool.query<PgType>(TYPES);
      return new Describer(pool, identity, new Map(rows.map((t) => [t.oid, t])));
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  public async describe(texts: string[]): Promise<DescribeResult[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const results: DescribeResult[] = [];
      for (const text of texts) {
        await client.query('SAVEPOINT describe');
        results.push(
          await client
            .query<{ described: Described }>('SELECT pg_describe($1)::json AS described', [text])
            .then(({ rows }) => ({ ok: true as const, described: rows[0]!.described }))
            .catch(async (error: pg.DatabaseError) => {
              await client.query('ROLLBACK TO SAVEPOINT describe');
              return {
                ok: false as const,
                message: error.message,
                position: error.position == null ? undefined : Number(error.position),
              };
            }),
        );
      }
      return results;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  public async close() {
    await this.pool.end();
  }
}

const schemaDatabase = async (server: string, files: string[]) => {
  const name = `pg_describe_${schemaIdentity(files)}`;
  const url = (database: string) => {
    const target = new URL(server);
    target.pathname = `/${database}`;
    return target.toString();
  };

  const admin = new pg.Client({ connectionString: server, connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rowCount === 0) {
      const building = `${name}_${randomBytes(4).toString('hex')}`;
      await admin.query(`CREATE DATABASE "${building}"`);
      try {
        await applySchema(url(building), files);
        await admin.query(`ALTER DATABASE "${building}" RENAME TO "${name}"`);
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS "${building}" WITH (FORCE)`);
      }
    }
  } finally {
    await admin.end();
  }
  return url(name);
};

const applySchema = async (url: string, files: string[]) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const file of files) {
      await client.query(readFileSync(file, 'utf8')).catch((error: Error) => {
        throw new Error(`Schema file ${path.basename(file)} failed: ${error.message}`, {
          cause: error,
        });
      });
    }
    await client.query('CREATE EXTENSION pg_describe');
  } finally {
    await client.end();
  }
};

export const dropStaleDatabases = async (config: Config) => {
  if (config.database == null) {
    return [];
  }
  const files = schemaFiles(config);
  const current = files.length > 0 ? `pg_describe_${schemaIdentity(files)}` : undefined;
  const admin = new pg.Client({ connectionString: config.database, connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname ~ '^pg_describe_[0-9a-f]{16}(_[0-9a-f]{8})?$' AND datname IS DISTINCT FROM $1",
      [current],
    );
    for (const { datname } of rows) {
      await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`);
    }
    return rows.map((r) => r.datname);
  } finally {
    await admin.end();
  }
};
