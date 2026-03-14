import type { ITraceExporter, Trace } from "../types.js";

export interface LanternExporterConfig {
  endpoint: string;
  apiKey?: string;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

/**
 * Exports traces to a Lantern ingest backend via HTTP POST.
 * Supports batching and exponential backoff retry on 5xx errors.
 */
export class LanternExporter implements ITraceExporter {
  readonly exporterType = "lantern";
  private endpoint: string;
  private apiKey?: string;
  private maxRetries: number;
  private retryBaseDelayMs: number;

  constructor(config: LanternExporterConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
  }

  async export(traces: Trace[]): Promise<void> {
    if (traces.length === 0) return;

    const url = `${this.endpoint}/v1/traces`;
    const body = JSON.stringify({ traces });

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body,
        });

        if (response.ok) {
          return;
        }

        // Retry on 5xx
        if (response.status >= 500 && attempt < this.maxRetries) {
          const delay = this.retryBaseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        const errorBody = await response.text().catch(() => "");
        throw new Error(
          `Lantern ingest failed: ${response.status} ${response.statusText} - ${errorBody}`
        );
      } catch (error) {
        if (attempt < this.maxRetries && error instanceof TypeError) {
          // Network error — retry
          const delay = this.retryBaseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
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
