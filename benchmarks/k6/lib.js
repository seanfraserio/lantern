/**
 * Shared utilities for Lantern k6 benchmarks.
 * Generates realistic trace payloads matching the ingest API schema.
 */

// ── UUID generation (k6-compatible, no crypto.randomUUID) ───────────────────

const HEX = "0123456789abcdef";

export function uuid() {
  // v4 UUID: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  let id = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      id += "-";
    } else if (i === 14) {
      id += "4";
    } else if (i === 19) {
      id += HEX[(Math.random() * 4) | 8]; // 8, 9, a, or b
    } else {
      id += HEX[(Math.random() * 16) | 0];
    }
  }
  return id;
}

// ── Trace generators ────────────────────────────────────────────────────────

const AGENTS = [
  "support-triage",
  "code-reviewer",
  "data-analyst",
  "content-writer",
  "research-assistant",
  "qa-tester",
  "devops-bot",
  "security-scanner",
];

const ENVIRONMENTS = ["production", "staging", "development", "canary"];
const STATUSES = ["success", "success", "success", "error", "running"]; // weighted toward success
const MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250514",
  "gpt-4o-mini",
  "gpt-4o",
];
const SPAN_TYPES = ["llm_call", "tool_call", "reasoning_step", "retrieval", "custom"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a single realistic span.
 */
function makeSpan(traceId) {
  const startTime = Date.now() - randInt(500, 5000);
  const durationMs = randInt(50, 3000);
  const model = pick(MODELS);
  const inputTokens = randInt(50, 2000);
  const outputTokens = randInt(10, 500);

  return {
    id: uuid(),
    traceId,
    type: pick(SPAN_TYPES),
    startTime,
    endTime: startTime + durationMs,
    durationMs,
    model,
    inputTokens,
    outputTokens,
    estimatedCostUsd: (inputTokens * 0.00001 + outputTokens * 0.00003),
    input: {
      messages: [
        { role: "user", content: `Benchmark test prompt ${randInt(1, 10000)}` },
      ],
    },
    output: {
      content: "Benchmark test response.",
      stopReason: "end_turn",
    },
  };
}

/**
 * Generate a single trace with 1-5 spans.
 */
export function makeTrace() {
  const id = uuid();
  const spanCount = randInt(1, 5);
  const spans = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  for (let i = 0; i < spanCount; i++) {
    const span = makeSpan(id);
    spans.push(span);
    totalInput += span.inputTokens || 0;
    totalOutput += span.outputTokens || 0;
    totalCost += span.estimatedCostUsd || 0;
  }

  const startTime = Date.now() - randInt(1000, 10000);
  const durationMs = randInt(500, 8000);

  return {
    id,
    sessionId: uuid(),
    agentName: pick(AGENTS),
    environment: pick(ENVIRONMENTS),
    startTime,
    endTime: startTime + durationMs,
    durationMs,
    status: pick(STATUSES),
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    estimatedCostUsd: totalCost,
    spans,
    source: {
      serviceName: "k6-benchmark",
      sdkVersion: "0.0.1",
      exporterType: "lantern",
    },
  };
}

/**
 * Generate a batch of N traces as a JSON request body string.
 */
export function makeBatch(size) {
  const traces = [];
  for (let i = 0; i < size; i++) {
    traces.push(makeTrace());
  }
  return JSON.stringify({ traces });
}
