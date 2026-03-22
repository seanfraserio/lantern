import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@lantern-ai/sdk": path.resolve(__dirname, "../../sdk/src/index.ts"),
    },
  },
});
