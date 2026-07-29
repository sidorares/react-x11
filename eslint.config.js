import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';

export default [
  {
    // Everything the docs site generates: the Docusaurus output, its cache,
    // and the playground's esbuild bundle (a megabyte of minified vendor
    // code that nothing here wrote).
    ignores: [
      'website/build/**',
      'website/.docusaurus/**',
      'website/static/demo/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.jsx', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
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
  {
    // The docs site's own React code runs in a browser, and the modules the
    // playground bundle is built from run there too.
    files: [
      'website/src/**',
      'website/scripts/browser-shims/**',
      'website/scripts/stubs/**',
      'website/scripts/demo-*.js',
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
