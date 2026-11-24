// ESLint configuration (flat config). Run: npm run lint
import js from '@eslint/js';
import globals from 'globals';

const rules = {
  'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
  'prefer-const': ['error', { destructuring: 'all' }],
  'no-var': 'error',
  eqeqeq: ['error', 'smart'],
  'no-implicit-coercion': ['error', { allow: ['!!'] }],
  'no-throw-literal': 'error',
  'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }]
};

export default [
  { ignores: ['node_modules/', 'dist/'] },
  js.configs.recommended,
  {
    // Extension pages, the service worker and the shared library (the library also runs in Node tests).
    files: ['*.js', 'lib/**/*.js', 'scripts/store/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions, ...globals.serviceworker }
    },
    rules
  },
  {
    // Content script: a classic script injected into pages.
    files: ['content.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.webextensions } }
  },
  {
    files: ['lib/store-worker.js'],
    languageOptions: { globals: { ...globals.worker } }
  },
  {
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs', 'native/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules
  }
];
