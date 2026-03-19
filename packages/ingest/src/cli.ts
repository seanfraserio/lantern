#!/usr/bin/env node
import { createServer } from "./server.js";

createServer({
  host: process.env.HOST ?? "127.0.0.1",
}).catch((err: unknown) => {
  console.error("Failed to start Lantern ingest server:", err);
  process.exit(1);
});
