// Vitest settings of every package: workspace packages resolve to their TypeScript source through the "jev-source" condition.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["jev-source"] },
  ssr: { resolve: { conditions: ["jev-source"], externalConditions: ["jev-source"] } },
  test: { dir: "test" },
});
