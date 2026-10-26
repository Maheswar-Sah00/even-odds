import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Browser code must never reach privileged (API-key) code paths. */
const browserBoundary = {
  patterns: [
    {
      group: ['node-appwrite', 'node-appwrite/*'],
      message: 'node-appwrite is server-only. Use the browser `appwrite` SDK via src/lib/appwrite.',
    },
    {
      group: ['**/functions/**', '**/scripts/**', '**/server/**'],
      message: 'Server modules may hold API keys and must not be imported by browser code.',
    },
    { group: ['node:*'], message: 'Node built-ins are not available in the browser.' },
  ],
};

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'playwright-report', 'test-results', 'functions/*/dist'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': ['error', { allow: ['info', 'warn', 'error'] }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-imports': ['error', browserBoundary],
    },
  },
  {
    // shared/ is imported by both browser and server: keep it pure and SDK-free.
    files: ['shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...browserBoundary.patterns,
            { group: ['appwrite', 'appwrite/*'], message: 'shared/ must stay SDK-free.' },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.ts', 'functions/**/*.ts', 'tests/**/*.{ts,tsx}', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
