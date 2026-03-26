/**
 * Lantern Batch Size Scaling — measures how batch size affects throughput
 *
 * Tests batch sizes 1, 10, 50, 100 at a fixed request rate to find the
 * optimal batch size. Larger batches = more traces per request = potentially
 * better throughput but higher per-request latency.
 *
 * DON'T run this directly — use run.sh which runs each batch size sequentially.
 *
 * Usage:
 *   BATCH_SIZE=1 k6 run benchmarks/k6/batch-size-scaling.js
 *   BATCH_SIZE=100 k6 run benchmarks/k6/batch-size-scaling.js
 */

import http from "k6/http";
import { check } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";
import { makeBatch } from "./lib.js";

const ingestLatency = new Trend("ingest_latency_ms", true);
const tracesIngested = new Counter("traces_ingested");
const acceptRate = new Rate("accept_rate");

const LANTERN_URL = __ENV.LANTERN_URL || "http://127.0.0.1:4100";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "bench-ingest-key";
const BATCH_SIZE = parseInt(__ENV.BATCH_SIZE || "10", 10);

// Fixed request rate — 30 req/s for 1 minute regardless of batch size
export const options = {
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  scenarios: {
    fixed_rate: {
      executor: "constant-arrival-rate",
      rate: 30,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 15,
      maxVUs: 60,
    },
  },
  thresholds: {
    accept_rate: ["rate>0.95"],
  },
};

export default function () {
  const body = makeBatch(BATCH_SIZE);

  const res = http.post(`${LANTERN_URL}/v1/traces`, body, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  const accepted = check(res, {
    "status is 202": (r) => r.status === 202,
  });

  acceptRate.add(accepted);
  ingestLatency.add(res.timings.duration);

  if (res.status === 202) {
    tracesIngested.add(BATCH_SIZE);
  }
}

export function handleSummary(data) {
  const p50 = data.metrics.ingest_latency_ms?.values?.med ?? "?";
  const p95 = data.metrics.ingest_latency_ms?.values?.["p(95)"] ?? "?";
  const total = data.metrics.traces_ingested?.values?.count ?? 0;

  const fmt = (v) => (typeof v === "number" ? v.toFixed(1) : v);

  const line = `  batch=${String(BATCH_SIZE).padStart(3)} │ p50: ${fmt(p50).padStart(7)}ms │ p95: ${fmt(p95).padStart(7)}ms │ traces: ${total} │ traces/s: ${(total / 60).toFixed(0)}\n`;

  return {
    stdout: line,
    [`benchmarks/results/batch-${BATCH_SIZE}.json`]: JSON.stringify({
      batch_size: BATCH_SIZE,
      total_traces: total,
      traces_per_second: Math.round(total / 60),
      p50_ms: p50,
      p95_ms: p95,
    }),
  };
}
