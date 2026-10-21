# The extension

## Installing

The extension needs PostgreSQL 18 or newer, on the describe server only.

### Ready-made image

```yaml
services:
  postgres:
    image: ghcr.io/seralexeev/pg_describe:18 # postgres:18-trixie plus the extension
```

### Your own image

`ghcr.io/seralexeev/pg_describe:18-extension` holds only the installed files, at the paths a Debian-based Postgres 18 image uses. Copy them into any such image, for example pgvector:

```dockerfile
FROM pgvector/pgvector:0.8.4-pg18-trixie
COPY --from=ghcr.io/seralexeev/pg_describe:18-extension / /
```

### From source

```sh
git clone https://github.com/seralexeev/pg_describe
cd pg_describe
docker build -t pg_describe:local .                                # postgres:18-trixie plus the extension
docker build --build-arg BASE=pgvector/pgvector:0.8.4-pg18-trixie -t my-postgres .
```

Outside Docker, with `pg_config` for Postgres 18 on the `PATH`: `cd extension && make && sudo make install`.

pg-describe runs `CREATE EXTENSION pg_describe` itself, in the database it describes against.

## What it proves

### Nullability of a column

A column is not null when Postgres can show it:

- a table column with `NOT NULL`, unless an outer join can null its side;
- a column a `WHERE`, `JOIN ... ON` or `HAVING` filter proves not null (`x IS NOT NULL`, `x = $1`, `x > 0`), using the planner's own predicate prover;
- a column a `CHECK` constraint proves not null under the filter, for example `CHECK (kind <> 'shop' OR store_id IS NOT NULL)` with `WHERE kind = 'shop'`;
- an expression built from non-null inputs with strict operators and functions, `COALESCE` with a non-null argument, `count(*)`, `EXISTS`, literals;
- a column of a view, a CTE or a subquery, followed through to its source;
- `RETURNING` values, including `old.` and `new.`, which can be null on the insert or delete side.

Elements of arrays are tracked separately, so `array_agg(x)` is `(T | null)[]` unless `x` is proved not null.

### Nullability of a parameter

A parameter may be null when it is inserted into a nullable column, sits inside `COALESCE`, or is tested with `IS NULL` / `IS NOT NULL`. A parameter compared with `=` cannot usefully be null and is typed as required.

### Row count

| Result | When |
| --- | --- |
| `one` | an aggregate without `GROUP BY`; `INSERT ... VALUES` of one row with `RETURNING`, unless a trigger can skip it or `ON CONFLICT DO NOTHING` applies |
| `maybe` | filters that pin a primary key, a unique constraint or a unique index, including a partial index whose predicate the filter implies; `LIMIT 1` |
| `many` | everything else |
| `none` | no columns (for example an `UPDATE` without `RETURNING`); decided by pg-describe from the column list |

### Limits

- Only what Postgres can see statically. A function's result is nullable unless the function is `STRICT` with non-null arguments, or is a SQL function whose body is proved not null.
- Each `.sql` statement is one statement. Multi-statement strings are rejected.
- Statements are described, never run. DDL inside a query file is analyzed against the schema as it is.
