// ESLint flat config. It currently covers only the experiment-sandbox and
// harness-buy-check workspaces, the same scope as `.prettierrc.harness-trial.json`.
// Widen `LINTED_WORKSPACES` once the rest of the repository is cleaned up.
//
// Prettier owns layout (indentation, wrapping, quotes). ESLint owns everything
// a printer cannot decide: braces, one declaration per statement, blank lines
// between logical steps, and code-quality rules.
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const LINTED_WORKSPACES = [
  'apps/experiment-sandbox',
  'automation/experiment-sandbox',
  'automation/harness-buy-check',
  'packages/experiment-sandbox',
];

/** Statements that always get a blank line before and after them. */
const STANDALONE_STATEMENTS = [
  'export',
  'function',
  'class',
  'interface',
  'type',
  'block-like', // if, for, try, ... ending in `}`
  'multiline-const',
  'multiline-let',
  'multiline-expression', // test(...), describe(...), new CfnOutput(...) spanning lines
];

/**
 * Blank lines and braces. Prettier keeps blank lines but never adds them, so
 * these rules are what stops dense, wall-of-text code. All are auto-fixable.
 *
 * In `padding-line-between-statements`, a later entry overrides an earlier one
 * for the same pair of statements, so each `any` relaxes the `always` above it.
 */
export const LAYOUT_RULES = {
  // Always use braces: an unbraced body silently drops a second statement
  // added under it.
  curly: ['error', 'all'],

  // `const a = 1, b = 2;` hides declarations at the end of long lines.
  'one-var': ['error', 'never'],

  '@stylistic/padding-line-between-statements': [
    'error',
    // One blank line after the import block.
    { blankLine: 'always', prev: 'import', next: '*' },
    { blankLine: 'any', prev: 'import', next: 'import' },
    // A blank line after a run of declarations, before the code that uses them.
    { blankLine: 'always', prev: ['const', 'let'], next: '*' },
    {
      blankLine: 'any',
      prev: ['singleline-const', 'singleline-let'],
      next: ['singleline-const', 'singleline-let'],
    },
    // Blank lines around declarations, blocks, and multi-line statements.
    { blankLine: 'always', prev: '*', next: STANDALONE_STATEMENTS },
    { blankLine: 'always', prev: STANDALONE_STATEMENTS, next: '*' },
    // A blank line before `return`, unless it is the first statement.
    { blankLine: 'always', prev: '*', next: 'return' },
  ],

  // No blank line at the start or end of a block.
  '@stylistic/padded-blocks': ['error', 'never'],

  '@stylistic/lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
};

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/cdk.out/**', '**/*.d.ts', '**/*.js'],
  },
  {
    files: LINTED_WORKSPACES.map((workspace) => `${workspace}/**/*.ts`),
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    plugins: { '@stylistic': stylistic },
    rules: {
      ...LAYOUT_RULES,

      // Allow intentionally unused `_name` parameters, like Rust and Python.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
