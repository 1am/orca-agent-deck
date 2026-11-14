import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/*.sdPlugin/bin/**', 'coverage/**', 'out/**'],
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
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    // Property Inspector script: runs in the host's browser and is loaded by the PI pages (defines `window.connectPi`)
    files: ['**/*.sdPlugin/ui/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        WebSocket: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
        document: 'readonly',
      },
    },
  },
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
