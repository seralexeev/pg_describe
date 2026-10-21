import * as path from 'node:path';

import { findConfig } from './config.ts';
import { formatDiagnostics, freshLock, missingStatements, runtimeModule, updateLock as describeIntoLock } from './project.ts';

export const pgDescribe = ({ updateLock = false }: { updateLock?: boolean } = {}) => ({
  name: 'pg-describe',
  enforce: 'pre' as const,
  async transform(source: string, id: string) {
    const [file] = id.split('?') as [string];
    if (!file.endsWith('.sql')) {
      return null;
    }
    const config = findConfig(path.dirname(file));
    if (updateLock && missingStatements(freshLock(config), source).length > 0) {
      const failures = await describeIntoLock(config, [file]);
      if (failures.length > 0) {
        throw new Error(formatDiagnostics(failures));
      }
    }
    return { code: runtimeModule(config, file, source), map: null };
  },
});
