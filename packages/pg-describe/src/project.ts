import { globSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { compileSqlFile, type Diagnostic, renderRuntimeModule } from './codegen.ts';
import { type Config, schemaFiles, schemaIdentity, statementKey } from './config.ts';
import { Describer } from './database.ts';
import { type Lock, type LockEntry, readLock, renderLock, writeLock } from './lock.ts';
import { parseSqlFile } from './sql_file.ts';

export type FileDiagnostics = { file: string; source: string; diagnostics: Diagnostic[] };

export const projectSqlFiles = (config: Config) => {
  const schema = new Set(schemaFiles(config));
  return globSync('**/*.sql', {
    cwd: config.root,
    exclude: (name) => name === 'node_modules' || name.startsWith('.'),
  })
    .map((file) => path.resolve(config.root, file))
    .filter((file) => !schema.has(file))
    .toSorted();
};

export const describeFiles = async (config: Config, files: string[]) => {
  const describer = await Describer.open(config);
  try {
    const statements: Record<string, LockEntry> = {};
    const failures: FileDiagnostics[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const compiled = await compileSqlFile(config, describer, source);
      if (compiled.diagnostics.length > 0) {
        failures.push({ file, source, diagnostics: compiled.diagnostics });
      }
      for (const { statement, entry } of compiled.statements) {
        if (entry != null) {
          statements[statementKey(statement.text)] = entry;
        }
      }
    }
    return { lock: { identity: describer.identity, statements } satisfies Lock, failures };
  } finally {
    await describer.close();
  }
};

export const updateLock = async (config: Config, files: string[]) => {
  const { lock, failures } = await describeFiles(config, files);
  const existing = readLock(config);
  writeLock(
    config,
    existing?.identity === lock.identity
      ? { identity: lock.identity, statements: { ...existing.statements, ...lock.statements } }
      : lock,
  );
  return failures;
};

export const checkLock = async (config: Config) => {
  const { lock, failures } = await describeFiles(config, projectSqlFiles(config));
  const existing = readLock(config);
  return { failures, upToDate: existing != null && renderLock(existing) === renderLock(lock), lock };
};

export const freshLock = (config: Config) => {
  const lock = readLock(config);
  if (lock == null || config.schema.length === 0) {
    return lock;
  }
  return lock.identity === schemaIdentity(schemaFiles(config)) ? lock : undefined;
};

export const missingStatements = (lock: Lock | undefined, source: string) =>
  parseSqlFile(source).statements.filter((s) => lock?.statements[statementKey(s.text)] == null);

export const runtimeModule = (config: Config, file: string, source: string) => {
  const { statements, errors } = parseSqlFile(source);
  if (errors.length > 0) {
    throw new Error(`${file}: ${errors[0]!.message}`);
  }
  const lock = readLock(config);
  return renderRuntimeModule(
    statements.map((statement) => {
      const entry = lock?.statements[statementKey(statement.text)];
      if (entry == null) {
        throw new Error(
          `${file}: statement '${statement.name}' is not described in ${config.lockFile}; run 'pg-describe lock'`,
        );
      }
      return { statement, entry };
    }),
  );
};

export const formatDiagnostics = (failures: FileDiagnostics[], cwd = process.cwd()) =>
  failures
    .flatMap(({ file, source, diagnostics }) =>
      diagnostics.map((d) => {
        const before = source.slice(0, d.start).split('\n');
        return `${path.relative(cwd, file)}:${before.length}:${before.at(-1)!.length + 1} - error PGD${d.code}: ${d.message}`;
      }),
    )
    .join('\n');
