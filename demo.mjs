#!/usr/bin/env node
/**
 * Lantern Local Demo
 *
 * Seeds the ingest server with realistic agent traces
 * and opens the dashboard in your browser.
 *
 * Run: node demo.mjs
 * Dashboard: http://localhost:4100
 */

import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { unlinkSync } from "node:fs";

const INGEST_URL = "http://localhost:4100";
const DB_PATH = ".demo-lantern.db";

// ── Import SDK and Ingest from built packages ──

const { LanternTracer, LanternExporter } = await import(
  "./packages/sdk/dist/index.js"
);
const { createServer } = await import("./packages/ingest/dist/index.js");

// ── Start the ingest server ──

console.log("\n━━━ LANTERN DEMO ━━━\n");

// Clean prior demo db
try { unlinkSync(DB_PATH); } catch {}
try { unlinkSync(DB_PATH + "-wal"); } catch {}
try { unlinkSync(DB_PATH + "-shm"); } catch {}

console.log("Starting ingest server...");
const { app, store } = await createServer({
  port: 4100,
  host: "127.0.0.1",
  dbPath: DB_PATH,
});

// ── Create tracers from different "services" ──

const supportTracer = new LanternTracer({
  serviceName: "customer-support-app",
  environment: "production",
  exporter: new LanternExporter({ endpoint: INGEST_URL }),
  flushIntervalMs: 600000,
});

const internalTracer = new LanternTracer({
  serviceName: "internal-tools",
  environment: "dev",
  exporter: new LanternExporter({ endpoint: INGEST_URL }),
  flushIntervalMs: 600000,
});

const pipelineTracer = new LanternTracer({
  serviceName: "data-platform",
  environment: "production",
  exporter: new LanternExporter({ endpoint: INGEST_URL }),
  flushIntervalMs: 600000,
});

// ── Helper ──

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Seed: Trace 1 — Support triage (production, success) ──

console.log("Seeding traces...");

const t1 = supportTracer.startTrace({
  agentName: "support-triage",
  agentVersion: "1.2.0",
  environment: "production",
  metadata: { ticketId: "TICKET-4521", priority: "high", customer: "Acme Corp" },
});

const classify = supportTracer.startSpan(t1.id, {
  type: "llm_call",
  input: {
    messages: [
      { role: "system", content: "You classify support tickets by urgency and route them to the appropriate team." },
      { role: "user", content: "My production database is returning 500 errors on all queries since the last deployment. This is affecting all customers." },
    ],
  },
  model: "claude-sonnet-4-5-20251001",
});
await sleep(150);
supportTracer.endSpan(classify.id, {
  content: "This is a P0 production incident affecting all customers.\n\nClassification: CRITICAL\nCategory: Database / Infrastructure\nImpact: Full service degradation\n\nThe timing correlation with a recent deployment strongly suggests a migration or configuration change caused the failure. Routing to infrastructure team with P0 priority.",
  toolCalls: [{ name: "route_ticket", input: { team: "infrastructure", priority: "P0" } }],
  stopReason: "tool_use",
}, { inputTokens: 245, outputTokens: 112 });

const route = supportTracer.startSpan(t1.id, {
  type: "tool_call",
  parentSpanId: classify.id,
  input: { args: { team: "infrastructure", priority: "P0" } },
  toolName: "route_ticket",
});
await sleep(45);
supportTracer.endSpan(route.id, { content: JSON.stringify({ routed: true, team: "infrastructure", oncallEngineer: "alice@example.com", escalationChain: ["alice", "bob", "carol"] }) });

const retrieval = supportTracer.startSpan(t1.id, {
  type: "retrieval",
  parentSpanId: classify.id,
  input: { prompt: "production database 500 errors after deployment" },
});
await sleep(80);
supportTracer.endSpan(retrieval.id, { content: "Found 3 similar incidents:\n• INC-3201 (2 weeks ago): Migration rollback needed — resolved in 23min\n• INC-2899 (1 month ago): Connection pool exhaustion — resolved in 45min\n• INC-2654 (3 months ago): Schema mismatch after deploy — resolved in 1h12min" });

const recommend = supportTracer.startSpan(t1.id, {
  type: "llm_call",
  input: {
    messages: [
      { role: "user", content: "Based on the 3 similar incidents found, provide a recommended action plan for the infrastructure team." },
    ],
  },
  model: "claude-sonnet-4-5-20251001",
});
await sleep(200);
supportTracer.endSpan(recommend.id, {
  content: "Recommended Action Plan (based on historical incident analysis):\n\n1. IMMEDIATE: Check the latest deployment for migration changes (67% of similar cases)\n2. VERIFY: Database connection pool settings and active connections\n3. PREPARE: Rollback script for the most recent migration\n4. MONITOR: Error rates on the observability dashboard\n5. COMMUNICATE: Post in #incidents channel, update status page\n\nHistorical resolution time for similar incidents: 23min - 1h12min\nMost likely root cause: Schema migration issue (67% probability based on INC-3201, INC-2654)",
  stopReason: "end_turn",
}, { inputTokens: 512, outputTokens: 178 });

supportTracer.endTrace(t1.id, "success");

// ── Seed: Trace 2 — Research assistant (dev, success) ──

const t2 = internalTracer.startTrace({
  agentName: "research-assistant",
  agentVersion: "0.8.3",
  environment: "dev",
  metadata: { userId: "user-42", topic: "quantum computing" },
});

const search = internalTracer.startSpan(t2.id, {
  type: "tool_call",
  input: { args: { query: "recent quantum computing breakthroughs 2026" } },
  toolName: "brave_search",
});
await sleep(320);
internalTracer.endSpan(search.id, { content: JSON.stringify({ results: ["IBM announces 1000-qubit processor with error correction", "Google achieves quantum error correction milestone below threshold", "Microsoft demonstrates topological qubit stability at room temperature"] }) });

const synthesize = internalTracer.startSpan(t2.id, {
  type: "llm_call",
  input: {
    messages: [
      { role: "user", content: "Summarize the recent quantum computing breakthroughs in 2026 based on search results." },
    ],
  },
  model: "claude-haiku-4-5-20251001",
});
await sleep(95);
internalTracer.endSpan(synthesize.id, {
  content: "Key quantum computing breakthroughs in 2026:\n\n• IBM launched a 1000-qubit processor with built-in error correction, marking the transition from NISQ to fault-tolerant quantum computing\n• Google achieved below-threshold quantum error correction, demonstrating that adding more qubits actually reduces errors\n• Microsoft demonstrated topological qubit stability at room temperature, potentially eliminating the need for extreme cooling\n\nThese advances collectively suggest practical quantum advantage may be achievable within 2-3 years for specific computational problems.",
  stopReason: "end_turn",
}, { inputTokens: 380, outputTokens: 134 });

internalTracer.endTrace(t2.id, "success");

// ── Seed: Trace 3 — Code reviewer (staging, error) ──

const t3 = internalTracer.startTrace({
  agentName: "code-reviewer",
  agentVersion: "2.0.1",
  environment: "staging",
  metadata: { prNumber: 847, repository: "acme/backend", author: "dave" },
});

const review = internalTracer.startSpan(t3.id, {
  type: "llm_call",
  input: {
    messages: [
      { role: "system", content: "You are a senior code reviewer. Review pull requests for bugs, security issues, and best practice violations." },
      { role: "user", content: "Review PR #847: Adds user authentication endpoint with JWT token generation and password hashing." },
    ],
  },
  model: "claude-sonnet-4-5-20251001",
});
await sleep(50);
internalTracer.endSpan(review.id, {}, { error: "Rate limit exceeded: 429 Too Many Requests. Retry after 30 seconds.", inputTokens: 1200, outputTokens: 0 });

internalTracer.endTrace(t3.id, "error");

// ── Seed: Trace 4 — Data pipeline agent (production, success) ──

const t4 = pipelineTracer.startTrace({
  agentName: "data-pipeline",
  agentVersion: "3.1.0",
  environment: "production",
  metadata: { pipelineId: "etl-daily-sync", source: "salesforce", destination: "snowflake" },
});

const extract = pipelineTracer.startSpan(t4.id, {
  type: "tool_call",
  input: { args: { source: "salesforce", query: "SELECT * FROM Opportunity WHERE LastModifiedDate >= YESTERDAY" } },
  toolName: "salesforce_query",
});
await sleep(400);
pipelineTracer.endSpan(extract.id, { content: JSON.stringify({ recordCount: 1247, bytesRead: 2_400_000 }) });

const transform = pipelineTracer.startSpan(t4.id, {
  type: "llm_call",
  input: {
    messages: [
      { role: "user", content: "Analyze the extracted 1,247 Salesforce Opportunity records. Identify data quality issues and suggest transformations for the Snowflake staging table." },
    ],
  },
  model: "claude-sonnet-4-5-20251001",
});
await sleep(180);
pipelineTracer.endSpan(transform.id, {
  content: "Data quality analysis of 1,247 records:\n\n• 23 records with null CloseDate (1.8%) — recommend defaulting to 90 days from CreateDate\n• 5 records with Amount = 0 but Stage = 'Closed Won' — flag for manual review\n• 142 records with duplicate ContactId — deduplicate, keep most recent\n• All currency values in USD — no conversion needed\n\nRecommended transformations applied. Ready for Snowflake load.",
  stopReason: "end_turn",
}, { inputTokens: 890, outputTokens: 145 });

const load = pipelineTracer.startSpan(t4.id, {
  type: "tool_call",
  parentSpanId: transform.id,
  input: { args: { table: "stg_opportunities", recordCount: 1247 } },
  toolName: "snowflake_load",
});
await sleep(250);
pipelineTracer.endSpan(load.id, { content: JSON.stringify({ loaded: 1247, skipped: 0, table: "stg_opportunities" }) });

pipelineTracer.endTrace(t4.id, "success");

// ── Seed: Trace 5 — Onboarding bot (dev, success) ──

const t5 = internalTracer.startTrace({
  agentName: "onboarding-bot",
  agentVersion: "1.0.0",
  environment: "dev",
  metadata: { newHire: "eve@example.com", department: "engineering" },
});

const greet = internalTracer.startSpan(t5.id, {
  type: "llm_call",
  input: {
    messages: [
      { role: "user", content: "New hire Eve just joined the engineering team. Generate a personalized onboarding checklist." },
    ],
  },
  model: "claude-haiku-4-5-20251001",
});
await sleep(60);
internalTracer.endSpan(greet.id, {
  content: "Welcome to the team, Eve! Here's your personalized onboarding checklist:\n\n✅ Set up your development environment (see #dev-setup)\n✅ Complete security training (due within 48h)\n✅ Schedule 1:1s with your manager and team lead\n✅ Review the engineering handbook in Notion\n✅ Join Slack channels: #engineering, #incidents, #standups\n✅ Set up VPN and SSH keys\n✅ Clone the monorepo and run the setup script",
  stopReason: "end_turn",
}, { inputTokens: 45, outputTokens: 98 });

internalTracer.endTrace(t5.id, "success");

// ── Flush all traces ──

await supportTracer.flush();
await internalTracer.flush();
await pipelineTracer.flush();

const count = await store.getTraceCount();
console.log(`✓ Seeded ${count} traces\n`);

// ── Open browser ──

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  Dashboard: http://localhost:4100");
console.log("  API:       http://localhost:4100/v1/traces");
console.log("  Health:    http://localhost:4100/health");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("\n  Press Ctrl+C to stop.\n");

// Open browser (macOS)
exec("open http://localhost:4100");

// Keep running
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await supportTracer.shutdown();
  await internalTracer.shutdown();
  await pipelineTracer.shutdown();
  await app.close();
  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(DB_PATH + "-wal"); } catch {}
  try { unlinkSync(DB_PATH + "-shm"); } catch {}
  process.exit(0);
});
