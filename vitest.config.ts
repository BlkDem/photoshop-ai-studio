import { defineConfig } from 'vitest/config';

/**
 * One test runner for the whole monorepo.
 *
 * `shared` is imported through its built `dist` (it is a compiled dependency of
 * the services), so `npm test` runs `npm run build` first — see the root
 * `pretest` script.
 */
export default defineConfig({
  test: {
    include: ['{shared,paint-engine,mcp-server,orchestrator,photoshop-plugin}/test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: process.env.CI ? ['dot'] : ['default'],
    pool: 'forks',
  },
});
