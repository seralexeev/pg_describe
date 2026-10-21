#!/usr/bin/env node
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { findConfig } from './config.ts';
import { dropStaleDatabases } from './database.ts';
import { checkLock, formatDiagnostics, projectSqlFiles, updateLock } from './project.ts';
import { writeLock } from './lock.ts';

const USAGE = `Usage: pg-describe <command> [--project <dir>]

  lock            Describe every query file of the project and rewrite the lock file.
  lock <files>    Describe only these files and merge them into the lock file.
  lock --check    Fail when the lock file is not up to date; writes nothing.
  clean           Drop the databases built for earlier versions of the schema.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    check: { type: 'boolean', default: false },
    project: { type: 'string', default: process.cwd() },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [command, ...files] = positionals;

if (values.help || (command !== 'lock' && command !== 'clean')) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const config = findConfig(files.length > 0 ? path.dirname(path.resolve(files[0]!)) : values.project);

const fail = (message: string) => {
  console.error(message);
  process.exit(1);
};

try {
  if (command === 'clean') {
    const dropped = await dropStaleDatabases(config);
    console.log(dropped.length === 0 ? 'Nothing to drop' : `Dropped ${dropped.join(', ')}`);
  } else if (files.length > 0) {
    const failures = await updateLock(config, files.map((f) => path.resolve(f)));
    if (failures.length > 0) {
      fail(formatDiagnostics(failures));
    }
  } else {
    const { failures, upToDate, lock } = await checkLock(config);
    if (failures.length > 0) {
      fail(formatDiagnostics(failures));
    }
    if (values.check) {
      if (!upToDate) {
        fail(`${path.relative(process.cwd(), config.lockFile)} is out of date; run 'pg-describe lock'`);
      }
    } else {
      writeLock(config, lock);
      console.log(
        `Described ${Object.keys(lock.statements).length} statements in ${projectSqlFiles(config).length} files`,
      );
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
