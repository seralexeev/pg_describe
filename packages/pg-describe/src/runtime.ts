export type Queryable = {
  query: (config: {
    text: string;
    values: unknown[];
    rowMode: 'array';
  }) => Promise<{ rows: unknown[][] }>;
};

export type SqlRows = 'none' | 'one' | 'maybe' | 'first' | 'firstOrNull' | 'many';

export type SqlShape = {
  name: string;
  params: readonly string[];
  json?: readonly string[];
  columns: readonly string[];
  rows: SqlRows;
};

type SqlResult<R, C extends SqlRows> = C extends 'none'
  ? void
  : C extends 'one' | 'first'
    ? R
    : C extends 'maybe' | 'firstOrNull'
      ? R | null
      : R[];

declare const rowType: unique symbol;

export type SqlQuery<P, R, C extends SqlRows> = {
  (db: Queryable, ...params: P extends void ? [] : [params: P]): Promise<SqlResult<R, C>>;
  readonly text: string;
  readonly [rowType]?: R;
  single: () => SqlQuery<P, R, 'one'>;
  singleOrNull: () => SqlQuery<P, R, 'maybe'>;
  first: () => SqlQuery<P, R, 'first'>;
  firstOrNull: () => SqlQuery<P, R, 'firstOrNull'>;
  many: () => SqlQuery<P, R, 'many'>;
};

export type SqlRow<Q> = Q extends { readonly [rowType]?: infer R } ? R : never;

export type SqlParams<Q> = Q extends (db: Queryable, ...params: infer P) => unknown
  ? P extends [infer Only]
    ? Only
    : void
  : never;

export class SqlRowCountError extends Error {
  public readonly query;
  public readonly count;

  public constructor(query: string, expected: string, count: number) {
    super(`Query ${query} expected ${expected} but returned ${count}`);
    this.name = 'SqlRowCountError';
    this.query = query;
    this.count = count;
  }
}

const pick = (name: string, rows: unknown[], mode: SqlRows) => {
  switch (mode) {
    case 'none':
      return undefined;
    case 'one':
      if (rows.length !== 1) {
        throw new SqlRowCountError(name, 'exactly one row', rows.length);
      }
      return rows[0];
    case 'maybe':
      if (rows.length > 1) {
        throw new SqlRowCountError(name, 'at most one row', rows.length);
      }
      return rows[0] ?? null;
    case 'first':
      if (rows.length === 0) {
        throw new SqlRowCountError(name, 'at least one row', 0);
      }
      return rows[0];
    case 'firstOrNull':
      return rows[0] ?? null;
    case 'many':
      return rows;
  }
};

export const sqlQuery = <P, R, C extends SqlRows>(
  text: string,
  { name, params, json = [], columns, rows }: SqlShape,
): SqlQuery<P, R, C> => {
  const values = (record: Record<string, unknown> | undefined) =>
    params.map((param) => {
      const value = record?.[param] ?? null;
      return value != null && json.includes(param) ? JSON.stringify(value) : value;
    });

  const build = (mode: SqlRows): SqlQuery<P, R, C> => {
    const run = async (db: Queryable, record?: Record<string, unknown>) => {
      const result = await db.query({ text, values: values(record), rowMode: 'array' });
      const objects = result.rows.map((row) =>
        Object.fromEntries(columns.map((column, i) => [column, row[i]])),
      );
      return pick(name, objects, mode);
    };
    return Object.assign(run, {
      text,
      single: () => build('one'),
      singleOrNull: () => build('maybe'),
      first: () => build('first'),
      firstOrNull: () => build('firstOrNull'),
      many: () => build('many'),
    }) as unknown as SqlQuery<P, R, C>;
  };

  return build(rows);
};
