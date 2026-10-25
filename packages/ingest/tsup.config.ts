import { defineConfig } from 'tsup';

// This private workspace helper is a build input, never a consumer dependency.
export default defineConfig({
  noExternal: [/^@freelancer\/shared-utils(?:\/|$)/],
});
