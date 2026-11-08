import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/*.sdPlugin/bin/**', 'coverage/**', 'kanban/**', 'out/**'],
  },
  js.configs.recommended,
  {
    // Orca plugin A is plain ESM that runs in Orca's worker (Node)
    files: ['orca-plugin/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    // core is pure logic: no @elgato/* imports
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['@elgato/*'], message: 'core is pure logic: no @elgato/* imports' }],
        },
      ],
    },
  },
);
