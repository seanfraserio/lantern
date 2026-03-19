#!/usr/bin/env node
import { createRequire } from "node:module";
import { createServer } from "./server.js";

const require_ = createRequire(import.meta.url);
const pkg = require_("../package.json") as { version: string };

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(pkg.version);
  process.exit(0);
}

createServer({
  host: "0.0.0.0", // Bind to all interfaces for Cloud Run / Docker
}).catch((err: unknown) => {
  console.error("Failed to start Lantern ingest server:", err);
  process.exit(1);
});
