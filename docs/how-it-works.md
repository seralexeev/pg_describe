# How it works

pg-describe has four parts. Each one does the minimum its stage needs.

```
               development and CI                          production
  ┌──────────────────────────────────────────────┐   ┌──────────────────────┐
  │ users.sql ──► content mapper ──► typed module │   │ users.sql            │
  │                    │   (tsc, editor)          │   │    + lock ──► loader │
  │                    ▼                          │   │               │      │
  │        Postgres 18 + pg_describe              │   │               ▼      │
  │                    ▲                          │   │       plain Postgres │
  │ users.sql ──► dev loader ──► lock (commit) ───┼──►│                      │
  └──────────────────────────────────────────────┘   └──────────────────────┘
```

## 1. The extension

`pg_describe(sql text) returns json` parses, analyzes and rewrites a statement with Postgres's own code, the same way `PREPARE` does, and walks the resulting tree:

```json
{
  "params": [{ "type": 25, "nullable": false }],
  "rows": "maybe",
  "columns": [{ "name": "email", "type": 25, "nullable": false }]
}
```

It never plans or executes the statement. The whole call runs inside a transaction that pg-describe rolls back. See [The extension](extension.md) for what it can prove.

## 2. The content mapper

TypeScript 7.1 lets a package take over a file extension. tsc and the TypeScript language server start the package's process, `node dist/mapper.js`, and talk to it over JSON-RPC on stdio:

1. `initialize`. The mapper answers with UTF-16 positions and the diagnostic source `pg-describe`.
2. `openProject` with the `options` from `tsconfig.json`. The mapper connects to the server, builds the schema database if needed, and returns `configIdentity` (the schema fingerprint) and `watchedFiles` (the schema files). The package declares `dynamicConfig: true`, so a schema change re-transforms every `.sql` file, in watch mode and incremental builds too.
3. `transform` for every `.sql` file in the program. The mapper splits the file into statements, describes them in one transaction, and returns a declaration-only module:

   ```ts
   import type { SqlQuery } from 'pg-describe';
   export declare const findUserByEmail: SqlQuery<{ email: string; }, { id: string; ... }, "maybe">;
   ```

   It also returns span mappings that tie `findUserByEmail` and `email` in this text to the same words in the `.sql` file, and diagnostics placed at the word Postgres complained about.

Content-mapped files are never emitted to JavaScript, which is why a runtime half exists at all.

## 3. The lock

At runtime a query needs four facts: its text, its parameter names, which parameters are JSON, and the shape of its result (column names and the proved row count). The first two come from the `.sql` file. The other two need `pg_describe`, which production does not have.

The lock file holds exactly those facts, keyed by a hash of each statement's text. It is small, deterministic and reviewable in a diff. It changes only when a query's result shape changes.

## 4. The loaders

| Entry point | Lock entry missing or stale |
| --- | --- |
| `pg-describe/register-dev`, `pgDescribe({ updateLock: true })` | Describes the file through the CLI and merges it into the lock |
| `pg-describe/register`, `pgDescribe()` | Throws at import, naming the statement and `pg-describe lock` |

Both turn a `.sql` file into the same JavaScript module, built from the file and the lock:

```js
import { sqlQuery } from 'pg-describe';
export const findUserByEmail = sqlQuery("SELECT id, email ... WHERE email = $1", {
  name: 'findUserByEmail', params: ['email'], rows: 'maybe', columns: ['id', 'email', 'name', 'role'],
});
```

The Node loader uses `module.registerHooks`, which is synchronous. The development loader therefore runs `pg-describe lock <file>` as a child process when it needs to describe something. That happens only on the first import after a query changes.

## Why not...

- **Generate `.sql.ts` files?** That works with any TypeScript, but they have to be regenerated, committed and reviewed, they drift, and errors point at generated code. The content mapper makes the `.sql` file itself the module.
- **Describe at runtime?** That would need the extension in production, plus a connection and a round trip for every statement at startup.
- **Infer types with a SQL parser in JavaScript?** Nullability across joins, views, `CHECK` constraints and functions, and row counts from unique indexes, are what the Postgres analyzer already knows. Reimplementing it would be approximate where this is exact.
- **Use `PREPARE` and `pg_prepared_statement`?** Postgres reports parameter and result types that way, but no nullability and no row count.
