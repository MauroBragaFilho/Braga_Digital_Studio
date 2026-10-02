'use strict';

const js = require('@eslint/js');
const globals = require('globals');

const sharedRules = {
  'no-undef': 'warn',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-self-assign': 'warn',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-prototype-builtins': 'off',
  'no-useless-escape': 'warn',
  'no-control-regex': 'off',
  'no-cond-assign': ['warn', 'except-parens'],
  'no-inner-declarations': 'warn',
  'no-case-declarations': 'warn',
  'no-async-promise-executor': 'warn',
  'no-misleading-character-class': 'warn',
  'no-constant-condition': ['warn', { checkLoops: false }],
  'require-atomic-updates': 'off'
};

module.exports = [
  {
    ignores: [
      'node_modules/**', 'dist/**', 'data/**', 'database/**', 'logs/**', '_Archives/**',
      '.freebuff/**', '.Teste*/**', '.tmp-clone-check/**', '.docs/**', 'build/**', 'release/**', 'out/**'
    ]
  },
  js.configs.recommended,
  // Processo principal / backend / scripts: Node + CommonJS
  {
    files: ['main.js', 'preload.js', 'src/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: sharedRules
  },
  // Renderer: navegador + módulos ES
  {
    files: ['renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser }
    },
    rules: sharedRules
  }
];
