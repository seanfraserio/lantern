#!/usr/bin/env node
import { createApiServer } from "./server.js";

const databaseUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;

if (!databaseUrl || !jwtSecret) {
  console.error("DATABASE_URL and JWT_SECRET environment variables are required");
  process.exit(1);
}

createApiServer({ databaseUrl, jwtSecret, host: "0.0.0.0" }).catch((err: unknown) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});
