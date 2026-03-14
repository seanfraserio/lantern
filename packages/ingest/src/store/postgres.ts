import type { ITraceStore, TraceQueryFilter, Trace, SourceSummary } from "@lantern-ai/sdk";

export interface PostgresConfig {
  connectionString: string;
  maxConnections?: number;
}

/**
 * PostgreSQL-backed trace store. Recommended for production deployments.
 */
export class PostgresTraceStore implements ITraceStore {
  constructor(private _config: PostgresConfig) {}

  // TODO: Implement with pg or postgres.js
  async insert(_traces: Trace[]): Promise<void> {
    throw new Error("PostgreSQL store not yet implemented");
  }

  async getTrace(_id: string): Promise<Trace | null> {
    throw new Error("PostgreSQL store not yet implemented");
  }

  async queryTraces(_filter: TraceQueryFilter): Promise<Trace[]> {
    throw new Error("PostgreSQL store not yet implemented");
  }

  async getTraceCount(): Promise<number> {
    throw new Error("PostgreSQL store not yet implemented");
  }

  async getSources(): Promise<SourceSummary[]> {
    throw new Error("PostgreSQL store not yet implemented");
  }
}
