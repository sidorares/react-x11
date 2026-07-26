const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.jsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: globals.node,
    },
    plugins: { react },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',
      'no-unused-vars': ['error', { args: 'none' }],
    },
  },
];
