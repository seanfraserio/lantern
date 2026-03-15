#!/usr/bin/env node
import { createProxyServer } from "./server.js";

createProxyServer({
  host: "0.0.0.0", // Bind to all interfaces for Cloud Run / Docker
}).then(({ port, host, ingestEndpoint }) => {
  console.log(`Lantern LLM Proxy running on ${host}:${port}`);
  console.log(`  Ingest endpoint: ${ingestEndpoint}`);
  console.log(`  Anthropic: POST http://${host}:${port}/anthropic/v1/messages`);
  console.log(`  OpenAI:    POST http://${host}:${port}/openai/v1/chat/completions`);
}).catch((err: unknown) => {
  console.error("Failed to start Lantern LLM Proxy:", err);
  process.exit(1);
});
