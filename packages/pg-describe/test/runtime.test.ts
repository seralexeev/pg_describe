import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { type SqlParams, type SqlRow, SqlRowCountError } from 'pg-describe';
import { createTestDatabase } from './database.ts';
import { countItems, getItem, insertItem, listItems } from './fixtures/items.sql';

let db: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ pool: db, drop } = await createTestDatabase());
  await db.query(readFileSync(new URL('fixtures/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  await db.query('TRUNCATE items');
});

afterAll(async () => {
  await drop();
});

describe('a query imported from a .sql file', () => {
  it('returns the row or null for a lookup by primary key', async () => {
    await insertItem(db, { id: 1, title: 'Lamp', kind: 'shop', note: null, payload: { color: 'red' } });

    const item = await getItem(db, { id: 1 });
    expectTypeOf(item).toEqualTypeOf<{
      id: number;
      title: string;
      kind: 'shop' | 'pos';
      note: string | null;
      payload: unknown;
    } | null>();
    expect(item).toEqual({ id: 1, title: 'Lamp', kind: 'shop', note: null, payload: { color: 'red' } });
    expect(await getItem(db, { id: 2 })).toBeNull();
  });

  it('sends a JSON array to a jsonb parameter as JSON', async () => {
    await insertItem(db, { id: 1, title: 'Lamp', kind: 'shop', payload: [1, 2] });
    expect((await getItem(db, { id: 1 }))?.payload).toEqual([1, 2]);
  });

  it('returns exactly one row for an aggregate', async () => {
    expectTypeOf<SqlRow<typeof countItems>>().toEqualTypeOf<{ total: number }>();
    expect(await countItems(db)).toEqual({ total: 0 });
  });

  it('returns an array for a statement that can match many rows', async () => {
    expectTypeOf<SqlParams<typeof listItems>>().toEqualTypeOf<{ kind?: 'shop' | 'pos' | null }>();
    await insertItem(db, { id: 1, title: 'Lamp', kind: 'shop' });
    await insertItem(db, { id: 2, title: 'Till', kind: 'pos' });
    expect(await listItems(db, { kind: 'pos' })).toEqual([{ id: 2, title: 'Till' }]);
    expect(await listItems(db, {})).toHaveLength(2);
  });

  it('lets the caller narrow the row count and enforces it', async () => {
    const single = listItems.single();
    expectTypeOf<Awaited<ReturnType<typeof single>>>().toEqualTypeOf<{ id: number; title: string }>();
    await expect(single(db, {})).rejects.toBeInstanceOf(SqlRowCountError);

    await insertItem(db, { id: 1, title: 'Lamp', kind: 'shop' });
    await insertItem(db, { id: 2, title: 'Till', kind: 'pos' });
    expect(await listItems.first()(db, {})).toEqual({ id: 1, title: 'Lamp' });
    await expect(single(db, {})).rejects.toThrow('Query listItems expected exactly one row but returned 2');
  });
});
