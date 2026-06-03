import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
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
    files: ['api/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Vitest tests run in Node (with jsdom for the hook test) and mock `global.fetch`.
    files: ['test/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
])
