import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config.
 *
 * Three environments live in this repo and they have genuinely different globals:
 *
 *  - Node services (`mcp-server`, `orchestrator`, `shared`) — typed, strict.
 *  - The browser bundle (`studio`) — DOM globals, React.
 *  - The UXP plugin (`photoshop-plugin`) — **plain JavaScript** that Photoshop
 *    loads directly. It gets no TypeScript parser and a hand-written globals
 *    allow-list for `require`, `WebSocket` and the UXP/Photoshop modules, so an
 *    accidental npm import fails the lint rather than the user's Photoshop.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'studio/dist/**',
      'tmp/**',
      'workspace/**',
      'data/**',
      '.eslintcache',
      // Agent scratch worktrees are full copies of this repo checked out inside
      // it. Linting them reports the same file twice and buries real errors in
      // hundreds of stale ones, so `npm run lint` has to skip them.
      '.kilo/**',
      '**/.kilo/**',
    ],
  },

  js.configs.recommended,

  // ---------------------------------------------------------------- Node code
  {
    files: ['shared/**/*.ts', 'mcp-server/**/*.ts', 'orchestrator/**/*.ts', 'vitest.config.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      'no-console': ['error', { allow: ['log', 'warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // --------------------------------------------------- repo scripts (plain JS)
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // ------------------------------------------------------------------- tests
  {
    files: ['**/test/**/*.ts', 'vitest.config.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // ------------------------------------------------------------------ studio
  {
    files: ['studio/**/*.{ts,tsx}', 'studio/vite.config.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // -------------------------------------------------------------- UXP plugin
  {
    files: ['photoshop-plugin/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: {
        // UXP runtime.
        WebSocket: 'readonly',
        // UXP panels get a real (if reduced) DOM: the plugin's HTML is parsed
        // and `document.getElementById` works.
        document: 'readonly',
        console: 'readonly',
        require: 'readonly',
        module: 'writable',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Promise: 'readonly',
      },
    },
    rules: {
      'no-var': 'off', // The plugin targets an ES5-ish UXP runtime on purpose.
      // UXP runs a constrained runtime: an unused `catch (err)` binding is the
      // normal way to write "this is expected to fail", so it is not flagged.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-console': 'off',
    },
  },
);
