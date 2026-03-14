export type { Trace, Span, EvalScore, TraceQueryFilter } from "@lantern-ai/sdk";

export interface DashboardConfig {
  apiUrl: string;
  refreshIntervalMs?: number;
}
