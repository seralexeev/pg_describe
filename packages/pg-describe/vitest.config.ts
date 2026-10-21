import { defineConfig } from 'vitest/config';

import { pgDescribe } from './src/vite.ts';

export default defineConfig({
  plugins: [pgDescribe({ updateLock: true })],
  test: { testTimeout: 30_000, hookTimeout: 60_000 },
});
