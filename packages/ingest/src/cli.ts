#!/usr/bin/env node
import { createServer } from "./server.js";

createServer({
  host: "0.0.0.0", // Bind to all interfaces for Cloud Run / Docker
}).catch((err: unknown) => {
  console.error("Failed to start Lantern ingest server:", err);
  process.exit(1);
});
