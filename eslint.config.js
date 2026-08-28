import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'

export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    extends: [
      js.configs.recommended,
      // Non-type-checked recommended set - keeps lint fast (no program build).
      ...tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // Serverless API handlers run in Node, not the browser.
    files: ['api/**/*.{js,ts}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The eval harness is a Node CLI (tsx), not browser code.
    files: ['eval/**/*.{js,ts}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Vitest tests run in Node (with jsdom for the hook test) and mock `global.fetch`.
    // Test doubles (mock req/res, fetch stubs) legitimately need `any`, so the
    // no-explicit-any rule is relaxed here only - app code (api/, src/) keeps it on.
    files: ['test/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
