# pg-describe

Import `.sql` files straight into TypeScript and get fully typed queries. Postgres itself checks them.

```sql
-- src/users.sql
/* @name findUserByEmail */
SELECT id, email, name, role
FROM users
WHERE email = :email;
```

```ts
import { findUserByEmail } from './users.sql';

const user = await findUserByEmail(pool, { email });
//    ^? { id: string; email: string; name: string | null; role: 'admin' | 'member' } | null
```

There is no codegen step and no generated files to commit. Nothing runs in production either:

- **Types come from Postgres.** A small C extension, `pg_describe`, runs Postgres's own parser, analyzer and rewriter on each statement. It reports the parameter and column types, whether each one can be null, and whether the statement returns no row, at most one, exactly one or many. Views are expanded. `NOT NULL`, `CHECK` constraints, joins, filters and unique indexes are all taken into account.
- **TypeScript asks for them itself.** pg-describe is a [TypeScript 7.1 content mapper](https://github.com/microsoft/typescript-go/pull/4712). `tsc` and the editor send it every `.sql` file. It answers with a typed module, and errors point at the right line and column of the `.sql` file.
- **Production never needs the extension.** The runtime only needs to know how to shape each result. That lives in `pg-describe.lock.json`, which you commit, much like the offline mode of sqlx. Your production database stays a plain Postgres or RDS.

## Quick start

You need Docker, Node 22.15 or newer and TypeScript 7.1.

**1. Start Postgres with the extension.**

```yaml
# compose.yaml
services:
  postgres:
    image: ghcr.io/seralexeev/pg_describe:18
    environment:
      POSTGRES_PASSWORD: postgres
    ports:
      - 5432:5432
```

```sh
docker compose up -d
```

Already have a Postgres image of your own, say with pgvector? Copy the extension into it instead, see [Installing the extension](docs/extension.md#installing).

**2. Install.**

```sh
npm install pg pg-describe
npm install -D typescript@beta @types/pg
```

**3. Register the content mapper** in `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "module": "nodenext",
    "strict": true,
    "noEmit": true
  },
  "contentMappers": [
    {
      "package": "pg-describe",
      "extensions": [".sql"],
      "options": {
        // A server with the extension; pg-describe creates its own database there.
        "database": "postgres://postgres:postgres@localhost:5432/postgres",
        // Your schema or migrations, applied in file name order.
        "schema": "db/migrations/*.sql"
      }
    }
  ],
  "include": ["src"]
}
```

**4. Write queries.** Each statement starts with `/* @name ... */`, and `:param` marks a parameter.

```sql
-- src/users.sql
/* @name createUser */
INSERT INTO users (email, name)
VALUES (:email, :name)
RETURNING id, created_at;

/* @name listUsers */
SELECT id, email, name FROM users ORDER BY email;
```

**5. Import and run.**

```ts
// src/main.ts
import pg from 'pg';
import { createUser, listUsers } from './users.sql';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { id } = await createUser(pool, { email: 'ada@example.com', name: 'Ada' });
console.log(id, await listUsers(pool));
```

```jsonc
// package.json
{
  "type": "module",
  "scripts": {
    "typecheck": "tsc --runExternalCode",
    "dev": "node --import pg-describe/register-dev src/main.ts",
    "start": "node --import pg-describe/register src/main.ts"
  }
}
```

```sh
npm run typecheck   # types and SQL errors, straight from Postgres
npm run dev         # runs and writes pg-describe.lock.json; commit it
npm start           # what production runs: reads the lock, never describes
```

[`example/`](example) is a project you can run as it is: `docker compose up -d && npm install && npm run dev`.

## How it fits together

| Where | What runs | Needs the extension |
| --- | --- | --- |
| Editor, `tsc --runExternalCode` | The content mapper describes each `.sql` file and returns a typed module | Yes, the local server |
| `node --import pg-describe/register-dev`, `pgDescribe({ updateLock: true })` | The loader turns each `.sql` file into JavaScript and describes statements the lock is missing | Yes, the local server |
| `pg-describe lock --check` in CI | Re-describes every query and fails if the lock is out of date | Yes, the CI service |
| `node --import pg-describe/register`, `pgDescribe()` | The loader builds JavaScript from the `.sql` file and the lock alone | **No** |

The production entry points never open a connection to describe anything. When a statement is missing from the lock, they fail at import with the command to run, instead of guessing at the result shape. You choose the mode by which entry point you import, not by an environment variable.

## Using the queries

A query is a function of a database (`pg.Pool`, `pg.Client` or `pg.PoolClient`, or anything with a compatible `query` method) and its parameters. It resolves to a value shaped by the row count Postgres proved:

| Proved row count | Example | Resolves to |
| --- | --- | --- |
| none | `INSERT` without `RETURNING` | `void` |
| one | `INSERT ... RETURNING`, `count(*)` | `Row`, and throws `SqlRowCountError` otherwise |
| maybe | lookup by primary key or unique key | `Row \| null` |
| many | anything else | `Row[]` |

Where you know more than Postgres can prove, narrow it: `listUsers.single()`, `.singleOrNull()`, `.first()`, `.firstOrNull()` or `.many()`. Columns come back camelCased. A `json`/`jsonb` parameter accepts any JSON value, arrays included. `SqlRow<typeof q>` and `SqlParams<typeof q>` extract the types.

```ts
import type { SqlRow } from 'pg-describe';
import { listUsers } from './users.sql';

type User = SqlRow<typeof listUsers>;
```

## Vite and Vitest

```ts
// vitest.config.ts
import { pgDescribe } from 'pg-describe/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [pgDescribe({ updateLock: true })],
});
```

For `vite build`, use `pgDescribe()` without `updateLock`, so the build reads only the lock.

## CI

Run the extension image as a service and check that the lock is current. `tsc --runExternalCode` type-checks the queries along the way:

```yaml
services:
  postgres:
    image: ghcr.io/seralexeev/pg_describe:18
    env: { POSTGRES_PASSWORD: postgres }
    ports: ['5432:5432']
steps:
  - run: npx tsc --runExternalCode
  - run: npx pg-describe lock --check
```

## Editor

VS Code with the TypeScript 7 extension runs content mappers in trusted workspaces. Turn them on or off with `js/ts.contentMappers.enabled`. The mapper ties each query's `@name` and each `:param` to the matching name in the generated types, so hover, go to definition and references can move between the `.sql` file and the TypeScript that uses it. SQL errors appear in the `.sql` file as you type.

## Documentation

- [Configuration](docs/configuration.md): mapper options, type mapping and overrides, the lock file
- [How it works](docs/how-it-works.md): the content mapper, the lock, the loaders, and why it is built this way
- [The extension](docs/extension.md): installing it in your own image, and what it can and cannot prove
- [Production](docs/production.md): deploying without the extension

## Requirements

- PostgreSQL 18 or newer for the describe server. Production can run any version your queries work on.
- TypeScript 7.1 or newer, for content mappers.
- Node.js 22.15 or newer, for synchronous module hooks. Node 23.6 or newer runs `.ts` files directly.

## License

MIT
