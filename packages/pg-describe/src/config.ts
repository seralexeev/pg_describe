import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export const PACKAGE = 'pg-describe';

export type Options = {
  database?: string;
  schema?: string | string[];
  types?: Record<string, string>;
  lock?: string;
};

export type Config = {
  root: string;
  database: string | undefined;
  schema: string[];
  types: Record<string, string>;
  lockFile: string;
};

export const resolveConfig = (root: string, options: Options = {}): Config => ({
  root,
  database: options.database ?? process.env.PG_DESCRIBE_URL,
  schema: options.schema == null ? [] : [options.schema].flat(),
  types: options.types ?? {},
  lockFile: path.resolve(root, options.lock ?? 'pg-describe.lock.json'),
});

export const findConfig = (from: string): Config => {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const tsconfig = path.join(dir, 'tsconfig.json');
    if (existsSync(tsconfig)) {
      const { contentMappers = [] } = parseJsonc(readFileSync(tsconfig, 'utf8')) as {
        contentMappers?: Array<{ package: string; options?: Options }>;
      };
      const entry = contentMappers.find((m) => m.package === PACKAGE);
      if (entry != null) {
        return resolveConfig(dir, entry.options);
      }
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`No tsconfig.json with a '${PACKAGE}' content mapper above ${from}`);
    }
  }
};

const JSONC_NOISE = /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\/|,(?=(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*[}\]])/g;

const parseJsonc = (text: string): unknown =>
  JSON.parse(text.replace(JSONC_NOISE, (_, string: string | undefined) => string ?? ''));

export const schemaFiles = (config: Config) =>
  config.schema
    .flatMap((pattern) => globSync(pattern, { cwd: config.root }))
    .map((file) => path.resolve(config.root, file))
    .toSorted();

export const schemaIdentity = (files: string[]) => {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.basename(file)).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
};

export const statementKey = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);
