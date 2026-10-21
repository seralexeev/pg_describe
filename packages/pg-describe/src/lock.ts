import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import type { Config } from './config.ts';
import type { SqlRows } from './runtime.ts';

export type LockEntry = {
  rows: Exclude<SqlRows, 'first' | 'firstOrNull'>;
  columns: string[];
  json?: string[];
};

export type Lock = {
  identity: string;
  statements: Record<string, LockEntry>;
};

export const readLock = (config: Config): Lock | undefined =>
  existsSync(config.lockFile)
    ? (JSON.parse(readFileSync(config.lockFile, 'utf8')) as Lock)
    : undefined;

export const renderLock = (lock: Lock) =>
  `${JSON.stringify(
    {
      identity: lock.identity,
      statements: Object.fromEntries(Object.entries(lock.statements).toSorted(([a], [b]) => (a < b ? -1 : 1))),
    },
    null,
    2,
  )}\n`;

export const writeLock = (config: Config, lock: Lock) => {
  const temporary = `${config.lockFile}.${process.pid}`;
  writeFileSync(temporary, renderLock(lock));
  renameSync(temporary, config.lockFile);
};
