import { defineConfig } from "vitest/config";

// Tests run in the default Node environment. React component and hook tests opt
// into jsdom with a `// @vitest-environment jsdom` docblock, so the api/ and lib/
// suites stay fast in Node.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.{ts,tsx,js,jsx}"],
    // Stubs the browser APIs jsdom lacks (matchMedia, ResizeObserver); a no-op
    // in the node-environment files.
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**", "api/**", "shared/**"],
      exclude: ["src/main.tsx"],
      // About 3 points under the measured values so a real drop fails CI but
      // normal churn doesn't. Raise them as coverage rises.
      thresholds: {
        lines: 91,
        statements: 89,
        functions: 85,
        branches: 78,
      },
    },
  },
});
