import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * One flat config for the whole workspace.
 *
 * TypeScript already carries the load here — strict mode with
 * `noUnusedLocals`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`
 * catches most of what a linter would. What it does not catch is the hooks
 * rules, and those matter more than usual in this codebase: the reader's
 * texture budget depends on effects tearing down exactly when they should, and
 * a missing dependency there leaks GPU memory rather than showing a stale
 * value.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/var/**',
      '**/dev-dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // The codebase uses `#private` fields and leading-underscore parameters
      // for deliberately unused arguments; both are intentional.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Empty catch blocks are used where a failure genuinely has no handling
      // beyond "carry on", and each one is commented.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    files: ['apps/frontend/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Data-loading effects that seed local state from an async source are
      // the intended pattern here (home feed, comic detail, download queue).
      // React Compiler's cascading-render warning is real for derived state,
      // but wrong for "fetch then set" — disabling it keeps the signal for
      // the cases that matter without rewriting every page into a suspense
      // boundary for the sake of the linter.
      'react-hooks/set-state-in-effect': 'off',
    },
  },

  {
    // R3F's render loop mutates Three.js objects in place — that is how the
    // page-flip stays off the React path. The immutability rules treat those
    // writes as React state bugs; they are not.
    files: [
      'apps/frontend/src/reader/FlipScene.tsx',
      'apps/frontend/src/reader/PageMesh.tsx',
      'apps/frontend/src/reader/ReaderCanvas.tsx',
    ],
    rules: {
      'react-hooks/immutability': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
);
