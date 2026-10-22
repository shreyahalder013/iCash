/* =========================================================
   ICASH — ESLint Configuration (Flat Config)
   ========================================================= */
import globals from 'globals';
import js from '@eslint/js';

export default [
  { ignores: ['node_modules/', 'models/', '*.json', '*.html', '*.css', 'coverage/', 'dist/', '.env*', 'js/libs/', '*.min.js', '*.test.js'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2022
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'off', // Disable for browser globals in frontend
      'no-console': 'off',
      'eqeqeq': ['warn', 'always'],
      'curly': ['warn', 'all'],
      'no-var': 'warn',
      'prefer-const': 'warn',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['server/**/*.test.js'],
    languageOptions: {
      sourceType: 'module'
    }
  }
];