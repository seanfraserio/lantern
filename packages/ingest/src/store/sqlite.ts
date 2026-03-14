import type { ITraceStore, TraceQueryFilter, Trace, SourceSummary } from "@lantern-ai/sdk";
import Database from "better-sqlite3";

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

/**
 * SQLite-backed trace store. Default for OSS self-hosted deployments.
 */
export class SqliteTraceStore implements ITraceStore {
  private db: Database.Database;

  constructor(dbPath: string = "lantern.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        agent_version TEXT,
        environment TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        source TEXT,
        spans TEXT NOT NULL DEFAULT '[]',
        scores TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_name);
      CREATE INDEX IF NOT EXISTS idx_traces_env ON traces(environment);
      CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
      CREATE INDEX IF NOT EXISTS idx_traces_start ON traces(start_time);
    `);
  }

  async insert(traces: Trace[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO traces (
        id, session_id, agent_name, agent_version, environment,
        start_time, end_time, duration_ms, status,
        total_input_tokens, total_output_tokens, estimated_cost_usd,
        metadata, source, spans, scores
      ) VALUES (
        @id, @sessionId, @agentName, @agentVersion, @environment,
        @startTime, @endTime, @durationMs, @status,
        @totalInputTokens, @totalOutputTokens, @estimatedCostUsd,
        @metadata, @source, @spans, @scores
      )
    `);

    const insertMany = this.db.transaction((traces: Trace[]) => {
      for (const trace of traces) {
        stmt.run({
          id: trace.id,
          sessionId: trace.sessionId,
          agentName: trace.agentName,
          agentVersion: trace.agentVersion ?? null,
          environment: trace.environment,
          startTime: trace.startTime,
          endTime: trace.endTime ?? null,
          durationMs: trace.durationMs ?? null,
          status: trace.status,
          totalInputTokens: trace.totalInputTokens,
          totalOutputTokens: trace.totalOutputTokens,
          estimatedCostUsd: trace.estimatedCostUsd,
          metadata: JSON.stringify(trace.metadata),
          source: trace.source ? JSON.stringify(trace.source) : null,
          spans: JSON.stringify(trace.spans),
          scores: trace.scores ? JSON.stringify(trace.scores) : null,
        });
      }
    });

    insertMany(traces);
  }

  async getTrace(id: string): Promise<Trace | null> {
    const row = this.db.prepare("SELECT * FROM traces WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTrace(row);
  }

  async queryTraces(filter: TraceQueryFilter): Promise<Trace[]> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.agentName) {
      conditions.push("agent_name = @agentName");
      params.agentName = filter.agentName;
    }
    if (filter.environment) {
      conditions.push("environment = @environment");
      params.environment = filter.environment;
    }
    if (filter.status) {
      conditions.push("status = @status");
      params.status = filter.status;
    }
    if (filter.serviceName) {
      conditions.push("json_extract(source, '$.serviceName') = @serviceName");
      params.serviceName = filter.serviceName;
    }
    if (filter.startAfter) {
      conditions.push("start_time >= @startAfter");
      params.startAfter = filter.startAfter;
    }
    if (filter.startBefore) {
      conditions.push("start_time <= @startBefore");
      params.startBefore = filter.startBefore;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(filter.limit ?? 100, 1000);
    const offset = filter.offset ?? 0;

    const rows = this.db
      .prepare(`SELECT * FROM traces ${where} ORDER BY start_time DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as Record<string, unknown>[];

    return rows.map((row) => this.rowToTrace(row));
  }

  async getTraceCount(): Promise<number> {
    const result = this.db.prepare("SELECT COUNT(*) as count FROM traces").get() as { count: number };
    return result.count;
  }

  async getSources(): Promise<SourceSummary[]> {
    const rows = this.db.prepare(`
      SELECT
        json_extract(source, '$.serviceName') as service_name,
        json_extract(source, '$.sdkVersion') as sdk_version,
        json_extract(source, '$.exporterType') as exporter_type,
        COUNT(*) as trace_count,
        MAX(start_time) as last_seen,
        GROUP_CONCAT(DISTINCT environment) as environments,
        GROUP_CONCAT(DISTINCT agent_name) as agents
      FROM traces
      WHERE source IS NOT NULL
      GROUP BY service_name, sdk_version, exporter_type
      ORDER BY last_seen DESC
    `).all() as Record<string, unknown>[];

    return rows.map((row) => ({
      serviceName: (row.service_name as string) ?? "unknown",
      sdkVersion: (row.sdk_version as string) ?? undefined,
      exporterType: (row.exporter_type as string) ?? undefined,
      traceCount: row.trace_count as number,
      lastSeen: row.last_seen as number,
      environments: ((row.environments as string) ?? "").split(",").filter(Boolean),
      agents: ((row.agents as string) ?? "").split(",").filter(Boolean),
    }));
  }

  private rowToTrace(row: Record<string, unknown>): Trace {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      agentName: row.agent_name as string,
      agentVersion: (row.agent_version as string) ?? undefined,
      environment: row.environment as string,
      startTime: row.start_time as number,
      endTime: (row.end_time as number) ?? undefined,
      durationMs: (row.duration_ms as number) ?? undefined,
      status: row.status as Trace["status"],
      totalInputTokens: row.total_input_tokens as number,
      totalOutputTokens: row.total_output_tokens as number,
      estimatedCostUsd: row.estimated_cost_usd as number,
      metadata: safeJsonParse(row.metadata as string, {}),
      source: safeJsonParse(row.source as string | null, undefined),
      spans: safeJsonParse(row.spans as string, []),
      scores: safeJsonParse(row.scores as string | null, undefined),
    };
  }

  close(): void {
    this.db.close();
  }
}
