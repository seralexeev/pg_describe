# Configuration

Everything is configured in one place, the `pg-describe` entry of `contentMappers` in `tsconfig.json`. The content mapper, the loaders and the CLI all read it. The loaders and the CLI find the nearest `tsconfig.json` above the `.sql` file, or above the directory given with `--project`. That file must contain the entry; `extends` is not followed.

```jsonc
{
  "contentMappers": [
    {
      "package": "pg-describe",
      "extensions": [".sql"],
      "options": {
        "database": "postgres://postgres:postgres@localhost:5432/postgres",
        "schema": ["db/migrations/*.sql"],
        "types": { "int8": "number" },
        "lock": "pg-describe.lock.json"
      }
    }
  ]
}
```

## Options

### `database`

The connection string of a Postgres 18 server that has the `pg_describe` extension available. Defaults to the `PG_DESCRIBE_URL` environment variable.

### `schema`

One glob or a list of globs, relative to the `tsconfig.json`. The files are applied in sorted order to a database that pg-describe creates on the server, named `pg_describe_<hash of the files>`, and the statements are described against that database. Recommended:

- Types follow the schema in your repository, not whatever state your development database happens to be in.
- The database is built once per version of the schema and reused, even across checkouts and worktrees.
- The editor watches the files and re-describes when they change.

Each file is sent as one simple query, so it can hold any number of statements. Migration tool metadata is not understood; the files have to be plain SQL. Files matched by `schema` are never treated as query files.

Without `schema`, statements are described against `database` itself. pg-describe runs `CREATE EXTENSION IF NOT EXISTS pg_describe` there and fingerprints the catalog (tables, constraints, indexes, views, functions, enums) to tell when the types need refreshing.

Old schema databases stay on the server until `pg-describe clean` drops them. It drops every `pg_describe_*` database on the server except the current one; another project that shares the server rebuilds its database the next time it needs it.

### `types`

Overrides keyed by Postgres type name, as found in `pg_type.typname`. Use `_name` for the array of `name`. An override applies to both parameters and columns. Use one wherever you register a custom node-postgres type parser:

```ts
pg.types.setTypeParser(20, (value) => Number(value));
```

```jsonc
"types": { "int8": "number", "_int8": "number[]" }
```

### `lock`

The path of the lock file, relative to the `tsconfig.json`. Defaults to `pg-describe.lock.json`.

## Default type mapping

These follow what node-postgres returns when no custom parsers are registered.

| Postgres | Column | Parameter |
| --- | --- | --- |
| `bool` | `boolean` | `boolean` |
| `int2`, `int4`, `oid`, `float4`, `float8` | `number` | `number` |
| `int8` | `string` | `number \| bigint \| string` |
| `numeric` | `string` | `number \| string` |
| `date`, `timestamp`, `timestamptz` | `Date` | `Date \| string` |
| `json`, `jsonb` | `unknown` | `unknown`, sent through `JSON.stringify` |
| `bytea` | `Buffer` | `Buffer` |
| enum | union of its labels | union of its labels |
| array of a type node-postgres parses | `T[]`, or `(T \| null)[]` when an element can be null | `readonly T[]` |
| anything node-postgres leaves as text (`uuid`, `text`, `inet`, arrays of enums) | `string` | `string` |
| anything else node-postgres parses | `unknown` | `string` |

A column that can be null adds `| null`. A parameter that can be null becomes optional and accepts `null`.

## Query files

- A statement starts at `/* @name identifier */` and runs to the next annotation. A trailing `;` is optional.
- `:name` is a parameter. Repeating it reuses the same parameter. Casts (`::int`), strings, quoted identifiers, comments and dollar-quoted bodies are left alone.
- Every column needs a unique name after camelCasing; add `AS` where Postgres would call it `?column?`.
- A `.sql` file without any `@name` annotation is not a query file. It produces an empty module and no errors, so migrations and scripts can live next to queries.

## The lock file

```json
{
  "identity": "79610e54694edc08",
  "statements": {
    "5e077640936b3d0b": { "rows": "maybe", "columns": ["id", "email", "name", "role"] },
    "7b2c1d233267c9b6": { "rows": "one", "columns": ["id"], "json": ["meta"] }
  }
}
```

Each statement is keyed by a hash of its text. It records only what the runtime needs: the proved row count, the column names in order, and which parameters are JSON. `identity` is the schema fingerprint the entries were described against. With `schema`, the development loaders compare it to the files on disk and re-describe when they differ. The production loaders trust the lock as it is, so the schema files do not have to ship with the application; `pg-describe lock --check` in CI is what keeps it current.

| Command | Effect |
| --- | --- |
| `pg-describe lock` | Describes every query file under the project and rewrites the lock, dropping entries nothing uses |
| `pg-describe lock <files...>` | Describes these files and merges them in; this is what `register-dev` runs |
| `pg-describe lock --check` | Exits with 1 when the lock is not exactly what `pg-describe lock` would write |
| `pg-describe clean` | Drops the databases of earlier schema versions |

Query files are every `*.sql` under the project directory, except `node_modules`, dot directories and `schema` files.
