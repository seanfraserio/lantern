import pg from "pg";
import type { ITraceStore, TraceQueryFilter, Trace, SourceSummary, EvalScore } from "@openlantern-ai/sdk";
import { instrumentPool } from "../lib/timed-pool.js";

const { Pool } = pg;

export interface PostgresConfig {
  connectionString: string;
  tenantSchema: string;
  poolSize?: number;
}

/**
 * PostgreSQL-backed trace store with schema-per-tenant isolation.
 * Uses fully qualified table names to avoid search_path issues with pooled connections.
 */
export class PostgresTraceStore implements ITraceStore {
  private pool: pg.Pool;
  private schema: string;

  constructor(config: PostgresConfig) {
    if (!/^[a-z0-9_]{1,63}$/.test(config.tenantSchema)) {
      throw new Error(
        `Invalid tenant schema name: "${config.tenantSchema}". ` +
        `Must match /^[a-z0-9_]{1,63}$/.`
      );
    }
    this.pool = instrumentPool(new Pool({
      connectionString: config.connectionString,
      max: config.poolSize ?? 15,
    }));
    this.schema = config.tenantSchema;
  }

  private get table(): string {
    return `"${this.schema}"."traces"`;
  }

  async initialize(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL,
        agent_name TEXT NOT NULL,
        agent_version TEXT,
        environment TEXT NOT NULL,
        start_time BIGINT NOT NULL,
        end_time BIGINT,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}',
        source JSONB,
        spans JSONB NOT NULL DEFAULT '[]',
        scores JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS "idx_${this.schema}_agent" ON ${this.table}(agent_name)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS "idx_${this.schema}_env" ON ${this.table}(environment)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS "idx_${this.schema}_status" ON ${this.table}(status)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS "idx_${this.schema}_start" ON ${this.table}(start_time DESC)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS "idx_${this.schema}_agent_start" ON ${this.table}(agent_name, start_time DESC)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS "idx_${this.schema}_env_start" ON ${this.table}(environment, start_time DESC)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS "idx_${this.schema}_status_start" ON ${this.table}(status, start_time DESC)`);
  }

  async insert(traces: Trace[]): Promise<void> {
    if (traces.length === 0) return;

    // Build multi-row VALUES for batch insert (1 round-trip instead of N)
    const COLS_PER_ROW = 16;
    const params: unknown[] = [];
    const valueRows: string[] = [];

    for (let i = 0; i < traces.length; i++) {
      const offset = i * COLS_PER_ROW;
      const placeholders = Array.from({ length: COLS_PER_ROW }, (_, j) => `$${offset + j + 1}`);
      valueRows.push(`(${placeholders.join(",")})`);

      const trace = traces[i];
      params.push(
        trace.id, trace.sessionId, trace.agentName,
        trace.agentVersion ?? null, trace.environment,
        trace.startTime, trace.endTime ?? null,
        trace.durationMs ?? null, trace.status,
        trace.totalInputTokens, trace.totalOutputTokens,
        trace.estimatedCostUsd,
        JSON.stringify(trace.metadata),
        trace.source ? JSON.stringify(trace.source) : null,
        JSON.stringify(trace.spans),
        trace.scores ? JSON.stringify(trace.scores) : null,
      );
    }

    await this.pool.query(
      `INSERT INTO ${this.table} (
        id, session_id, agent_name, agent_version, environment,
        start_time, end_time, duration_ms, status,
        total_input_tokens, total_output_tokens, estimated_cost_usd,
        metadata, source, spans, scores
      ) VALUES ${valueRows.join(",")}
      ON CONFLICT (id) DO NOTHING`,
      params
    );
  }

  async getTrace(id: string): Promise<Trace | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return null;
    return this.rowToTrace(rows[0]);
  }

  async queryTraces(filter: TraceQueryFilter): Promise<Trace[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filter.agentName) {
      conditions.push(`agent_name = $${paramIdx++}`);
      params.push(filter.agentName);
    }
    if (filter.environment) {
      conditions.push(`environment = $${paramIdx++}`);
      params.push(filter.environment);
    }
    if (filter.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filter.status);
    }
    if (filter.serviceName) {
      conditions.push(`source->>'serviceName' = $${paramIdx++}`);
      params.push(filter.serviceName);
    }
    if (filter.startAfter) {
      conditions.push(`start_time >= $${paramIdx++}`);
      params.push(filter.startAfter);
    }
    if (filter.startBefore) {
      conditions.push(`start_time <= $${paramIdx++}`);
      params.push(filter.startBefore);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(filter.limit ?? 100, 1000);
    const offset = filter.offset ?? 0;

    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.table} ${where} ORDER BY start_time DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params
    );

    return rows.map((row) => this.rowToTrace(row));
  }

  async updateScores(traceId: string, scores: EvalScore[]): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table} SET scores = $1 WHERE id = $2`,
      [JSON.stringify(scores), traceId]
    );
  }

  async getTraceCount(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM ${this.table}`
    );
    return rows[0].count;
  }

  async getSources(): Promise<SourceSummary[]> {
    const { rows } = await this.pool.query(`
      SELECT
        source->>'serviceName' AS service_name,
        source->>'sdkVersion' AS sdk_version,
        source->>'exporterType' AS exporter_type,
        COUNT(*)::int AS trace_count,
        MAX(start_time)::bigint AS last_seen,
        ARRAY_AGG(DISTINCT environment) AS environments,
        ARRAY_AGG(DISTINCT agent_name) AS agents
      FROM ${this.table}
      WHERE source IS NOT NULL
      GROUP BY service_name, sdk_version, exporter_type
      ORDER BY last_seen DESC
    `);

    return rows.map((row) => ({
      serviceName: (row.service_name as string) ?? "unknown",
      sdkVersion: (row.sdk_version as string) ?? undefined,
      exporterType: (row.exporter_type as string) ?? undefined,
      traceCount: row.trace_count as number,
      lastSeen: Number(row.last_seen),
      environments: (row.environments as string[]).filter(Boolean),
      agents: (row.agents as string[]).filter(Boolean),
    }));
  }

  async dropSchema(): Promise<void> {
    await this.pool.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private rowToTrace(row: Record<string, unknown>): Trace {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      agentName: row.agent_name as string,
      agentVersion: (row.agent_version as string) ?? undefined,
      environment: row.environment as string,
      startTime: Number(row.start_time),
      endTime: row.end_time ? Number(row.end_time) : undefined,
      durationMs: (row.duration_ms as number) ?? undefined,
      status: row.status as Trace["status"],
      totalInputTokens: row.total_input_tokens as number,
      totalOutputTokens: row.total_output_tokens as number,
      estimatedCostUsd: row.estimated_cost_usd as number,
      metadata: row.metadata as Record<string, unknown>,
      source: (row.source as Trace["source"]) ?? undefined,
      spans: (row.spans as Trace["spans"]) ?? [],
      scores: (row.scores as Trace["scores"]) ?? undefined,
    };
  }
}
