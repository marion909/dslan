'use strict';
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'public/**', 'data/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['warn', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-unreachable': 'warn',
    },
  },
];
