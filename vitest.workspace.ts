import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/sdk/vitest.config.ts",
  "packages/ingest/vitest.config.ts",
  "packages/evaluator/vitest.config.ts",
  "packages/proxy/vitest.config.ts",
  "packages/api/vitest.config.ts",
  "packages/dashboard/vitest.config.ts",
  "packages/enterprise/vitest.config.ts",
  "packages/integrations/cohere/vitest.config.ts",
  "packages/integrations/mistral/vitest.config.ts",
  "packages/integrations/bedrock/vitest.config.ts",
  "packages/integrations/openai-agents/vitest.config.ts",
  "packages/integrations/mastra/vitest.config.ts",
  // NOTE: packages/enterprise/.core-api is excluded — it's a template that gets
  // overlaid into the enterprise repo via CI rsync. Its tests run there, not here.
  // It shares the package name @openlantern-ai/api with packages/api, so pnpm
  // cannot resolve its dependencies in the OSS workspace.
]);
