import type { Trace, TraceQueryFilter } from "./types.js";

/**
 * API client for the Lantern ingest backend.
 */
export class LanternApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getTraces(filter?: TraceQueryFilter): Promise<Trace[]> {
    const params = new URLSearchParams();
    if (filter?.agentName) params.set("agentName", filter.agentName);
    if (filter?.environment) params.set("environment", filter.environment);
    if (filter?.status) params.set("status", filter.status);
    if (filter?.limit) params.set("limit", String(filter.limit));

    const response = await fetch(`${this.baseUrl}/v1/traces?${params}`);
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = (await response.json()) as { traces: Trace[] };
    return data.traces;
  }

  async getTrace(id: string): Promise<Trace> {
    const response = await fetch(`${this.baseUrl}/v1/traces/${id}`);
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return (await response.json()) as Trace;
  }

  async getHealth(): Promise<{ status: string; traceCount: number }> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return (await response.json()) as { status: string; traceCount: number };
  }
}
