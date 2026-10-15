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
      // A floor, not a target: each threshold is the measured value rounded
      // down to the nearest 5.
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 75,
        branches: 65,
      },
    },
  },
});
