import { defineConfig } from 'tsup';

// Bundle the canonical workspace helper rather than shipping a file: link.
export default defineConfig({
  noExternal: [/^@freelancer\/shared-utils(?:\/|$)/],
});
