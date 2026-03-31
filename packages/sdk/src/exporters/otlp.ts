import { createRequire } from "node:module";
import type { ITraceExporter, Trace, Span, SpanType } from "../types.js";

const require = createRequire(import.meta.url);
const { version: SDK_VERSION } = require("../../package.json") as { version: string };

export interface OtlpExporterConfig {
  endpoint: string;
  headers?: Record<string, string>;
}

// ─── OTLP wire-format types ───

interface OtlpKeyValue {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string };
}

interface OtlpExportRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

// ─── Helpers ───

/** Remove dashes from a UUID and return the first `len` hex characters. */
function hexId(uuid: string, len: number): string {
  return uuid.replace(/-/g, "").slice(0, len);
}

/** Map a Lantern SpanType to an OTLP span kind number. */
function spanKind(type: SpanType): number {
  switch (type) {
    case "llm_call":
      return 3; // CLIENT — outbound call to an LLM
    case "tool_call":
      return 3; // CLIENT — outbound call to a tool
    case "retrieval":
      return 3; // CLIENT
    default:
      return 1; // INTERNAL
  }
}

/** Build an OTLP attribute, skipping undefined values. */
function attr(key: string, value: string | number | undefined): OtlpKeyValue | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { key, value: { intValue: String(value) } };
    }
    return { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

function convertSpan(span: Span): OtlpSpan {
  const nameParts: string[] = [span.type];
  if (span.toolName) nameParts.push(span.toolName);

  const endTime = span.endTime ?? span.startTime;

  const attributes: OtlpKeyValue[] = (
    [
      attr("model", span.model),
      attr("inputTokens", span.inputTokens),
      attr("outputTokens", span.outputTokens),
      attr("estimatedCostUsd", span.estimatedCostUsd),
      attr("toolName", span.toolName),
    ] as Array<OtlpKeyValue | null>
  ).filter((a): a is OtlpKeyValue => a !== null);

  let statusCode = 0; // UNSET
  let statusMessage: string | undefined;
  if (span.error) {
    statusCode = 2; // ERROR
    statusMessage = span.error;
  } else if (span.endTime !== undefined) {
    statusCode = 1; // OK
  }

  return {
    traceId: hexId(span.traceId, 32),
    spanId: hexId(span.id, 16),
    parentSpanId: span.parentSpanId ? hexId(span.parentSpanId, 16) : undefined,
    name: nameParts.join(" "),
    kind: spanKind(span.type),
    startTimeUnixNano: String(span.startTime * 1_000_000),
    endTimeUnixNano: String(endTime * 1_000_000),
    attributes,
    status: statusMessage
      ? { code: statusCode, message: statusMessage }
      : { code: statusCode },
  };
}

function buildExportRequest(traces: Trace[]): OtlpExportRequest {
  return {
    resourceSpans: traces.map((trace) => ({
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: trace.agentName } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "@openlantern-ai/sdk", version: SDK_VERSION },
          spans: trace.spans.map(convertSpan),
        },
      ],
    })),
  };
}

// ─── Exporter ───

/**
 * OpenTelemetry-compatible exporter.
 * Converts Lantern traces to OTLP format and exports via HTTP (JSON).
 */
export class OtlpExporter implements ITraceExporter {
  readonly exporterType = "otlp";
  private endpoint: string;
  private headers: Record<string, string>;
  private maxRetries: number;
  private retryBaseDelayMs: number;

  constructor(config: OtlpExporterConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.headers = config.headers ?? {};
    this.maxRetries = 3;
    this.retryBaseDelayMs = 1000;
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = this.retryBaseDelayMs * Math.pow(2, attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async export(traces: Trace[]): Promise<void> {
    if (traces.length === 0) return;

    const url = `${this.endpoint}/v1/traces`;
    const body = JSON.stringify(buildExportRequest(traces));

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.headers,
          },
          body,
        });

        if (response.ok) {
          return;
        }

        // Retry on 5xx
        if (response.status >= 500 && attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }

        const errorBody = await response.text().catch(() => "");
        throw new Error(
          `OTLP export failed: ${response.status} ${response.statusText} - ${errorBody}`
        );
      } catch (error) {
        if (attempt < this.maxRetries && error instanceof TypeError) {
          // Network error — retry
          await this.backoff(attempt);
          continue;
        }
        throw error;
      }
    }
  }

  async shutdown(): Promise<void> {
    // No persistent connections to close
  }
}
