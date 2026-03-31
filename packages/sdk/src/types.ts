/**
 * Identifies the source that produced a trace — which service,
 * SDK version, and exporter sent it to the ingest server.
 */
export interface TraceSource {
  serviceName: string;
  sdkVersion?: string;
  exporterType?: string;
}

/**
 * A Trace represents one complete agent execution.
 */
export interface Trace {
  id: string;
  sessionId: string;
  agentName: string;
  agentVersion?: string;
  environment: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: TraceStatus;
  spans: Span[];
  metadata: Record<string, unknown>;
  source?: TraceSource;
  scores?: EvalScore[];
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
}

export type TraceStatus = "running" | "success" | "error";

/**
 * A Span is one step in agent reasoning.
 */
export interface Span {
  id: string;
  traceId: string;
  parentSpanId?: string;
  type: SpanType;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  input: SpanInput;
  output?: SpanOutput;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  toolName?: string;
  toolResult?: unknown;
  error?: string;
}

export type SpanType =
  | "llm_call"
  | "tool_call"
  | "reasoning_step"
  | "retrieval"
  | "custom";

export interface SpanInput {
  messages?: Array<{ role: string; content: string }>;
  prompt?: string;
  args?: unknown;
}

export interface SpanOutput {
  content?: string;
  toolCalls?: unknown[];
  stopReason?: string;
}

export interface EvalScore {
  scorer: string;
  score: number;
  label?: string;
  reasoning?: string;
}

// ─── Tracer configuration ───

export interface TracerConfig {
  serviceName?: string;
  environment?: string;
  exporter: ITraceExporter;
  batchSize?: number;
  flushIntervalMs?: number;
  promptsEndpoint?: string;
}

export interface ITraceExporter {
  readonly exporterType: string;
  export(traces: Trace[]): Promise<void>;
  shutdown(): Promise<void>;
}

export interface StartTraceOpts {
  agentName: string;
  agentVersion?: string;
  sessionId?: string;
  environment?: string;
  metadata?: Record<string, unknown>;
}

export interface StartSpanOpts {
  type: SpanType;
  parentSpanId?: string;
  input: SpanInput;
  model?: string;
  toolName?: string;
}

// ─── Evaluator types ───

export interface Scorer {
  name: string;
  score(trace: Trace): Promise<EvalScore>;
}

export interface Baseline {
  id: string;
  scorerName: string;
  meanScore: number;
  stdDev: number;
  sampleCount: number;
  createdAt: string;
}

export interface EvalRunResult {
  traceCount: number;
  scores: EvalScore[];
  regressions: Regression[];
}

export interface Regression {
  scorer: string;
  baseline: number;
  current: number;
  delta: number;
  isSignificant: boolean;
}

// ─── Ingest types ───

export interface TraceIngestRequest {
  traces: Trace[];
}

export interface TraceIngestResponse {
  accepted: number;
  errors?: string[];
}

export interface SourceSummary {
  serviceName: string;
  sdkVersion?: string;
  exporterType?: string;
  traceCount: number;
  lastSeen: number;
  environments: string[];
  agents: string[];
}

export interface ITraceStore {
  insert(traces: Trace[]): Promise<void>;
  getTrace(id: string): Promise<Trace | null>;
  queryTraces(filter: TraceQueryFilter): Promise<Trace[]>;
  getTraceCount(): Promise<number>;
  getSources(): Promise<SourceSummary[]>;
  updateScores(traceId: string, scores: EvalScore[]): Promise<void>;
}

export interface TraceQueryFilter {
  agentName?: string;
  environment?: string;
  status?: TraceStatus;
  serviceName?: string;
  startAfter?: number;
  startBefore?: number;
  limit?: number;
  offset?: number;
}
