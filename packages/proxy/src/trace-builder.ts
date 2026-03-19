/**
 * Creates Lantern traces from proxy-captured request/response data.
 *
 * Builds a complete Trace with a single "llm_call" span that can be
 * sent directly to the Lantern ingest endpoint.
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Trace, Span } from "@lantern-ai/sdk";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as { version: string };

export interface CapturedData {
  provider: "anthropic" | "openai";
  model: string;
  inputMessages: Array<{ role: string; content: string }>;
  outputContent: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  stopReason?: string | null;
  error?: string;
  serviceName?: string;
}

export function buildTrace(capture: CapturedData): Trace {
  const now = Date.now();
  const traceId = randomUUID();
  const spanId = randomUUID();

  const startTime = now - capture.durationMs;
  const endTime = now;

  const span: Span = {
    id: spanId,
    traceId,
    type: "llm_call",
    model: capture.model,
    startTime,
    endTime,
    durationMs: capture.durationMs,
    inputTokens: capture.inputTokens,
    outputTokens: capture.outputTokens,
    input: { messages: capture.inputMessages },
    output: {
      content: capture.outputContent,
      stopReason: capture.stopReason ?? undefined,
    },
    error: capture.error ?? undefined,
  };

  const trace: Trace = {
    id: traceId,
    sessionId: randomUUID(),
    agentName: capture.serviceName ?? `${capture.provider}-proxy`,
    environment: process.env.ENVIRONMENT ?? "production",
    startTime,
    endTime,
    durationMs: capture.durationMs,
    status: capture.error ? "error" : "success",
    totalInputTokens: capture.inputTokens,
    totalOutputTokens: capture.outputTokens,
    estimatedCostUsd: 0,
    metadata: { provider: capture.provider, proxied: true },
    source: {
      serviceName: capture.serviceName ?? "lantern-proxy",
      sdkVersion: PKG_VERSION,
      exporterType: "proxy",
    },
    spans: [span],
  };

  return trace;
}
