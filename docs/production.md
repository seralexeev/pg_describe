# Production

Production needs the `.sql` files, `pg-describe.lock.json`, and one of the read-only entry points. It needs no extension, no schema files and no describe server.

## Node, running TypeScript or JavaScript directly

```sh
node --import pg-describe/register dist/server.js
```

`pg-describe/register` reads the `.sql` file and the lock. When a statement is missing from the lock, it throws at import. It never connects to a database.

Ship the `.sql` files and the nearest `tsconfig.json` that holds the `pg-describe` entry, since the loader reads the lock path from it. With a build step that copies files, include both, for example:

```dockerfile
COPY tsconfig.json pg-describe.lock.json ./
COPY src ./src
```

## Bundling with Vite

```ts
import { pgDescribe } from 'pg-describe/vite';

export default defineConfig({ plugins: [pgDescribe()] });
```

The bundle contains plain JavaScript with the statements inlined. Nothing from pg-describe reads files at runtime except the small `sqlQuery` runtime.

## CI

The lock is generated, so CI makes sure it is current. Run the extension image as a service:

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: ghcr.io/seralexeev/pg_describe:18
        env:
          POSTGRES_PASSWORD: postgres
        ports: ['5432:5432']
        options: --health-cmd pg_isready --health-interval 2s --health-retries 30
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
      - run: npm ci
      - run: npx tsc --runExternalCode
      - run: npx pg-describe lock --check
```

`lock --check` re-describes every query against the schema in the commit. It fails when an entry is missing, stale or unused, so a migration that changes a result shape cannot merge without the lock that matches it.

## Production schema and the describe schema

The lock is proved against the `schema` files. When production lags behind them, for example while a migration rolls out before the new release, a query can briefly return a different shape than its lock entry says. Keep migrations compatible with the release in production, as you would without pg-describe.
