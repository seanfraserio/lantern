import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@openlantern-ai/sdk": path.resolve(__dirname, "../../sdk/src/index.ts"),
    },
  },
});
