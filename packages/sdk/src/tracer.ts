import { randomUUID } from "node:crypto";
import { version as SDK_VERSION } from "../package.json";
import type {
  Trace,
  TraceSource,
  Span,
  TracerConfig,
  ITraceExporter,
  StartTraceOpts,
  StartSpanOpts,
  SpanOutput,
  TraceStatus,
  TraceDropEvent,
} from "./types.js";
import { AgentSpan } from "./span.js";
import { Prompt, PromptClient } from "./prompts.js";


/**
 * Core tracer for Lantern. Manages traces and spans, and exports them
 * to a configured backend.
 */
const MAX_BUFFER_SIZE = 10_000;

export class LanternTracer {
  private traces: Map<string, Trace> = new Map();
  private activeSpans: Map<string, AgentSpan> = new Map();
  private buffer: Trace[] = [];
  private exporter: ITraceExporter;
  private batchSize: number;
  private flushIntervalMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private serviceName: string;
  private environment: string;
  private source: TraceSource;
  private promptClient?: PromptClient;
  private maxBufferSize: number;
  private onTraceDrop?: (event: TraceDropEvent) => void;
  private droppedTraces = 0;

  constructor(config: TracerConfig) {
    this.exporter = config.exporter;
    this.batchSize = config.batchSize ?? 50;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
    const configuredMax = config.maxBufferSize ?? MAX_BUFFER_SIZE;
    if (!Number.isInteger(configuredMax) || configuredMax < 1) {
      throw new Error(`maxBufferSize must be a positive integer, received ${String(config.maxBufferSize)}`);
    }
    this.maxBufferSize = configuredMax;
    this.onTraceDrop = config.onTraceDrop;
    this.serviceName = config.serviceName ?? "unknown";
    this.environment = config.environment ?? "dev";
    this.source = {
      serviceName: this.serviceName,
      sdkVersion: SDK_VERSION,
      exporterType: config.exporter.exporterType,
    };

    if (config.promptsEndpoint) {
      this.promptClient = new PromptClient(config.promptsEndpoint);
    }

    // Start periodic flush
    this.flushTimer = setInterval(() => {
      this.flush().catch(console.error);
    }, this.flushIntervalMs);

    // Unref the timer so it doesn't keep the process alive
    this.flushTimer.unref();
  }

  /**
   * Start a new trace for an agent execution.
   */
  startTrace(opts: StartTraceOpts): Trace {
    const trace: Trace = {
      id: randomUUID(),
      sessionId: opts.sessionId ?? randomUUID(),
      agentName: opts.agentName,
      agentVersion: opts.agentVersion,
      environment: opts.environment ?? this.environment,
      startTime: Date.now(),
      status: "running",
      spans: [],
      metadata: opts.metadata ?? {},
      source: this.source,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
    };

    this.traces.set(trace.id, trace);
    return trace;
  }

  /**
   * Start a new span within a trace.
   */
  startSpan(traceId: string, opts: StartSpanOpts): Span {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`);
    }

    const agentSpan = new AgentSpan(traceId, opts.type, opts.input, {
      parentSpanId: opts.parentSpanId,
      model: opts.model,
      toolName: opts.toolName,
    });

    this.activeSpans.set(agentSpan.id, agentSpan);
    return agentSpan.toSpan();
  }

  /**
   * End an active span with its output.
   */
  endSpan(
    spanId: string,
    output: SpanOutput,
    opts?: { inputTokens?: number; outputTokens?: number; error?: string }
  ): void {
    const agentSpan = this.activeSpans.get(spanId);
    if (!agentSpan) {
      throw new Error(`Span ${spanId} not found or already ended`);
    }

    const completedSpan = agentSpan.end(output, opts);
    const trace = this.traces.get(completedSpan.traceId);
    if (trace) {
      trace.spans.push(completedSpan);
      trace.totalInputTokens += completedSpan.inputTokens ?? 0;
      trace.totalOutputTokens += completedSpan.outputTokens ?? 0;
      trace.estimatedCostUsd += completedSpan.estimatedCostUsd ?? 0;
    }

    this.activeSpans.delete(spanId);
  }

  /**
   * End a trace with a final status.
   */
  endTrace(traceId: string, status: TraceStatus = "success"): void {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`);
    }

    trace.endTime = Date.now();
    trace.durationMs = trace.endTime - trace.startTime;
    trace.status = status;

    // Move to buffer for export
    this.buffer.push(trace);
    this.traces.delete(traceId);

    this.dropOldest("buffer_full");

    // Auto-flush if buffer is full
    if (this.buffer.length >= this.batchSize) {
      this.flush().catch(console.error);
    }
  }

  /**
   * Get a trace by ID (for inspection).
   */
  getTrace(traceId: string): Trace | undefined {
    return this.traces.get(traceId);
  }

  /**
   * Fetch a managed prompt by name. Requires promptsEndpoint to be set in TracerConfig.
   */
  getPrompt(name: string): Promise<Prompt> {
    if (!this.promptClient) {
      throw new Error("Prompt client not configured. Set promptsEndpoint in TracerConfig.");
    }
    return this.promptClient.getPrompt(name);
  }

  /**
   * Flush all buffered traces to the exporter.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const toExport = [...this.buffer];
    this.buffer = [];

    try {
      await this.exporter.export(toExport);
    } catch (error) {
      this.buffer.unshift(...toExport);
      this.dropOldest("flush_failed");
      throw error;
    }
  }

  /** Cumulative oldest traces dropped by the bounded buffer. */
  get droppedTraceCount(): number {
    return this.droppedTraces;
  }

  private dropOldest(reason: TraceDropEvent["reason"]): void {
    if (this.buffer.length <= this.maxBufferSize) return;
    const dropped = this.buffer.length - this.maxBufferSize;
    this.buffer = this.buffer.slice(dropped);
    this.droppedTraces += dropped;
    const event: TraceDropEvent = {
      dropped,
      bufferSize: this.buffer.length,
      maxBufferSize: this.maxBufferSize,
      reason,
    };
    try {
      this.onTraceDrop?.(event);
    } catch (error) {
      console.warn("[lantern] onTraceDrop observer failed:", error);
    }
    console.warn(
      `[lantern] Buffer exceeded ${this.maxBufferSize} traces. Dropped ${dropped} oldest traces (${reason}).`
    );
  }

  /**
   * Shutdown the tracer: flush remaining traces and stop the timer.
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();
    await this.exporter.shutdown();
  }
}
