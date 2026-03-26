/**
 * Lantern Mixed Workload — concurrent ingest + query
 *
 * The real-world scenario: agents are ingesting traces while a developer
 * has the dashboard open querying them. This test measures whether heavy
 * ingestion degrades query latency (SQLite reader/writer contention).
 *
 * Usage:
 *   k6 run benchmarks/k6/mixed-workload.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";
import { makeBatch } from "./lib.js";

// Separate metrics for reads vs writes
const ingestLatency = new Trend("ingest_latency_ms", true);
const queryLatency = new Trend("query_latency_ms", true);
const sourcesLatency = new Trend("sources_latency_ms", true);
const singleTraceLatency = new Trend("single_trace_latency_ms", true);
const tracesIngested = new Counter("traces_ingested");
const queryErrors = new Rate("query_error_rate");

const LANTERN_URL = __ENV.LANTERN_URL || "http://127.0.0.1:4100";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "bench-ingest-key";

const HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${AUTH_TOKEN}`,
};

export const options = {
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  scenarios: {
    // Heavy writer: 50 req/s × 10 traces = 500 traces/s sustained
    ingest: {
      executor: "constant-arrival-rate",
      exec: "ingest",
      rate: 50,
      timeUnit: "1s",
      duration: "3m",
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
    // Dashboard user: moderate query rate
    query_list: {
      executor: "constant-arrival-rate",
      exec: "queryTraces",
      rate: 5,
      timeUnit: "1s",
      duration: "3m",
      preAllocatedVUs: 5,
      maxVUs: 20,
      startTime: "10s", // start after some data is ingested
    },
    // Dashboard: sources endpoint (known to full-scan)
    query_sources: {
      executor: "constant-arrival-rate",
      exec: "querySources",
      rate: 1,
      timeUnit: "1s",
      duration: "3m",
      preAllocatedVUs: 2,
      maxVUs: 5,
      startTime: "10s",
    },
    // Dashboard: single trace lookup
    single_trace: {
      executor: "constant-arrival-rate",
      exec: "querySingleTrace",
      rate: 3,
      timeUnit: "1s",
      duration: "3m",
      preAllocatedVUs: 3,
      maxVUs: 10,
      startTime: "10s",
    },
  },
  thresholds: {
    ingest_latency_ms: ["p(95)<200"],
    query_latency_ms: ["p(95)<500"],
    sources_latency_ms: ["p(95)<1000"],
    query_error_rate: ["rate<0.05"],  // some 404s on single trace are expected
  },
};

// ── Ingest scenario ─────────────────────────────────────────────────────────

export function ingest() {
  const body = makeBatch(10);

  const res = http.post(`${LANTERN_URL}/v1/traces`, body, {
    headers: HEADERS,
    tags: { scenario: "ingest" },
  });

  check(res, { "ingest 202": (r) => r.status === 202 });
  ingestLatency.add(res.timings.duration);

  if (res.status === 202) {
    tracesIngested.add(10);
  }
}

// ── Query list scenario ─────────────────────────────────────────────────────

const QUERY_AGENTS = [
  "support-triage",
  "code-reviewer",
  "data-analyst",
  "content-writer",
];

let queryIteration = 0;

export function queryTraces() {
  const agent = QUERY_AGENTS[queryIteration++ % QUERY_AGENTS.length];

  const res = http.get(
    `${LANTERN_URL}/v1/traces?agentName=${agent}&limit=50`,
    {
      headers: HEADERS,
      tags: { scenario: "query_list" },
    },
  );

  const ok = check(res, { "query 200": (r) => r.status === 200 });
  queryErrors.add(!ok);
  queryLatency.add(res.timings.duration);
}

// ── Sources scenario ────────────────────────────────────────────────────────

export function querySources() {
  const res = http.get(`${LANTERN_URL}/v1/sources`, {
    headers: HEADERS,
    tags: { scenario: "query_sources" },
  });

  check(res, { "sources 200": (r) => r.status === 200 });
  sourcesLatency.add(res.timings.duration);
}

// ── Single trace lookup ─────────────────────────────────────────────────────

// First fetch a list to get real trace IDs, then look them up individually.
// This tests the :id lookup path under write contention.
let traceIds = [];

export function querySingleTrace() {
  // Refresh our ID pool periodically
  if (traceIds.length === 0 || queryIteration % 20 === 0) {
    const listRes = http.get(`${LANTERN_URL}/v1/traces?limit=20`, {
      headers: HEADERS,
    });
    if (listRes.status === 200) {
      try {
        const body = JSON.parse(listRes.body);
        traceIds = (body.traces || []).map((t) => t.id).filter(Boolean);
      } catch {
        // ignore parse errors
      }
    }
  }

  if (traceIds.length === 0) {
    sleep(0.5);
    return;
  }

  const id = traceIds[Math.floor(Math.random() * traceIds.length)];
  const res = http.get(`${LANTERN_URL}/v1/traces/${id}`, {
    headers: HEADERS,
    tags: { scenario: "single_trace" },
  });

  const ok = check(res, {
    "single trace 200 or 404": (r) => r.status === 200 || r.status === 404,
  });
  queryErrors.add(!ok);

  if (res.status === 200) {
    singleTraceLatency.add(res.timings.duration);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const fmt = (v) => (typeof v === "number" ? v.toFixed(1) : "?");
  const get = (name, pct) => pct === 50
    ? data.metrics[name]?.values?.med
    : data.metrics[name]?.values?.[`p(${pct})`];
  const traces = data.metrics.traces_ingested?.values?.count ?? 0;

  const summary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LANTERN MIXED WORKLOAD — INGEST + QUERY CONCURRENCY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Total traces ingested:  ${traces}

  Scenario             │    p50    │    p95    │    p99
  ─────────────────────┼───────────┼───────────┼──────────
  POST /v1/traces      │ ${fmt(get("ingest_latency_ms", 50)).padStart(7)}ms │ ${fmt(get("ingest_latency_ms", 95)).padStart(7)}ms │ ${fmt(get("ingest_latency_ms", 99)).padStart(7)}ms
  GET  /v1/traces      │ ${fmt(get("query_latency_ms", 50)).padStart(7)}ms │ ${fmt(get("query_latency_ms", 95)).padStart(7)}ms │ ${fmt(get("query_latency_ms", 99)).padStart(7)}ms
  GET  /v1/sources     │ ${fmt(get("sources_latency_ms", 50)).padStart(7)}ms │ ${fmt(get("sources_latency_ms", 95)).padStart(7)}ms │ ${fmt(get("sources_latency_ms", 99)).padStart(7)}ms
  GET  /v1/traces/:id  │ ${fmt(get("single_trace_latency_ms", 50)).padStart(7)}ms │ ${fmt(get("single_trace_latency_ms", 95)).padStart(7)}ms │ ${fmt(get("single_trace_latency_ms", 99)).padStart(7)}ms
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Key question: Does query latency degrade as ingestion rate increases?
  Compare p95 of query endpoints at the start vs end of the test run.
`;

  return { stdout: summary };
}
