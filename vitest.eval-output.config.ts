import { defineConfig } from "vitest/config";

// Only the committed eval/out check: the bootstrap re-runs are too slow for the
// main suite and eval/ is outside coverage, so this runs on its own, without
// coverage. Run it with `pnpm test:eval-output`.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/eval/committed-output.test.ts"],
  },
});
