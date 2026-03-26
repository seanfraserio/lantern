/**
 * Lantern Ingest Throughput — sustained trace ingestion at increasing rates
 *
 * This is the most important benchmark: how many traces/second can Lantern
 * ingest before write latency degrades? Since SQLite is single-writer,
 * this test finds the exact throughput ceiling.
 *
 * Usage:
 *   k6 run benchmarks/k6/ingest-throughput.js
 *   k6 run --out cloud benchmarks/k6/ingest-throughput.js  # send to Grafana
 *
 * Environment:
 *   LANTERN_URL   — ingest server URL (default http://127.0.0.1:4100)
 *   AUTH_TOKEN     — Bearer token (default bench-ingest-key)
 *   BATCH_SIZE     — traces per request (default 10)
 */

import http from "k6/http";
import { check } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";
import { makeBatch } from "./lib.js";

// Custom metrics
const ingestLatency = new Trend("ingest_latency_ms", true);
const tracesIngested = new Counter("traces_ingested");
const acceptRate = new Rate("accept_rate");
const rateLimited = new Counter("rate_limited_429");

const LANTERN_URL = __ENV.LANTERN_URL || "http://127.0.0.1:4100";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "bench-ingest-key";
const BATCH_SIZE = parseInt(__ENV.BATCH_SIZE || "10", 10);

export const options = {
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  scenarios: {
    ramp_up: {
      executor: "ramping-arrival-rate",
      startRate: 5,
      timeUnit: "1s",
      preAllocatedVUs: 20,
      maxVUs: 200,
      stages: [
        { duration: "30s", target: 20 },   // 200 traces/s (20 req × 10 batch)
        { duration: "1m", target: 20 },    // sustained
        { duration: "30s", target: 50 },   // 500 traces/s
        { duration: "1m", target: 50 },    // sustained
        { duration: "30s", target: 100 },  // 1000 traces/s
        { duration: "1m", target: 100 },   // sustained — likely hits SQLite ceiling
        { duration: "30s", target: 150 },  // 1500 traces/s — stress test
        { duration: "1m", target: 150 },   // sustained
        { duration: "30s", target: 0 },    // cool down
      ],
    },
  },
  thresholds: {
    ingest_latency_ms: ["p(95)<200"],   // 202 response should be fast (async write)
    accept_rate: ["rate>0.95"],         // >95% accepted
  },
};

export default function () {
  const body = makeBatch(BATCH_SIZE);

  const res = http.post(`${LANTERN_URL}/v1/traces`, body, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    tags: { batch_size: String(BATCH_SIZE) },
  });

  const accepted = check(res, {
    "status is 202": (r) => r.status === 202,
    "has accepted count": (r) => {
      try {
        const b = JSON.parse(r.body);
        return b.accepted > 0;
      } catch {
        return false;
      }
    },
  });

  acceptRate.add(accepted);
  ingestLatency.add(res.timings.duration);

  if (res.status === 202) {
    tracesIngested.add(BATCH_SIZE);
  } else if (res.status === 429) {
    rateLimited.add(1);
  }
}

export function handleSummary(data) {
  const p50 = data.metrics.ingest_latency_ms?.values?.med ?? "?";
  const p95 = data.metrics.ingest_latency_ms?.values?.["p(95)"] ?? "?";
  const p99 = data.metrics.ingest_latency_ms?.values?.["p(99)"] ?? "?";
  const total = data.metrics.traces_ingested?.values?.count ?? 0;
  const reqs = data.metrics.http_reqs?.values?.count ?? 0;
  const duration = data.state?.testRunDurationMs
    ? (data.state.testRunDurationMs / 1000).toFixed(0)
    : "?";
  const limited = data.metrics.rate_limited_429?.values?.count ?? 0;

  const throughput = duration !== "?" ? (total / parseFloat(duration)).toFixed(0) : "?";

  const fmt = (v) => (typeof v === "number" ? v.toFixed(1) : v);

  const summary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LANTERN INGEST THROUGHPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Batch size:          ${BATCH_SIZE} traces/request
  Total requests:      ${reqs}
  Total traces:        ${total}
  Rate limited (429):  ${limited}
  Duration:            ${duration}s
  Avg throughput:      ~${throughput} traces/s

  Ingest response latency (202 Accepted):
    p50:  ${fmt(p50)}ms
    p95:  ${fmt(p95)}ms
    p99:  ${fmt(p99)}ms
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  return { stdout: summary };
}
