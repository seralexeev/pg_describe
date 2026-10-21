import { randomBytes } from 'node:crypto';
import pg from 'pg';

export const SERVER = process.env.PG_DESCRIBE_TEST_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres';

export const databaseUrl = (name: string) => {
  const url = new URL(SERVER);
  url.pathname = `/${name}`;
  return url.toString();
};

export const createTestDatabase = async () => {
  const name = `pg_describe_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: SERVER });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: databaseUrl(name) });
  return {
    name,
    pool,
    drop: async () => {
      await pool.end();
      const client = new pg.Client({ connectionString: SERVER });
      await client.connect();
      await client.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await client.end();
    },
  };
};
