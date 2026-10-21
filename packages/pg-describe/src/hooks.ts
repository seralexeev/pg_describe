import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findConfig } from './config.ts';
import { freshLock, missingStatements, runtimeModule } from './project.ts';

const self = fileURLToPath(import.meta.url);
const cli = path.join(path.dirname(self), `cli${path.extname(self)}`);

export const registerSqlHooks = ({ updateLock }: { updateLock: boolean }) => {
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || !url.endsWith('.sql')) {
        return nextLoad(url, context);
      }
      const file = fileURLToPath(url);
      const source = readFileSync(file, 'utf8');
      const config = findConfig(path.dirname(file));
      if (updateLock && missingStatements(freshLock(config), source).length > 0) {
        execFileSync(process.execPath, [cli, 'lock', file], { stdio: ['ignore', 'ignore', 'inherit'] });
      }
      return { format: 'module', source: runtimeModule(config, file, source), shortCircuit: true };
    },
  });
};
