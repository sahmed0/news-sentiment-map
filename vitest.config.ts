import { defineConfig } from "vitest/config";

// Backend (api/**) tests run in the default Node environment. The single React
// hook test opts into jsdom via a `// @vitest-environment jsdom` docblock at the
// top of that file, so the rest of the suite stays fast in Node.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.{ts,tsx,js,jsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**", "api/**", "shared/**"],
      exclude: ["src/main.tsx"],
    },
  },
});
