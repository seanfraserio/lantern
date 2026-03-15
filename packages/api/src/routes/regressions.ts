import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getUser } from "../middleware/jwt.js";

const REGRESSION_THRESHOLD = 0.2; // 20% deviation
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface Span {
  type?: string;
  output?: { content?: string };
}

interface AgentMetrics {
  avgResponseLength: number;
  avgTokenCount: number;
  errorRate: number;
  avgLatencyMs: number;
  toolCallRatio: number;
  traceCount: number;
}

interface RegressionFlag {
  metric: string;
  baselineValue: number;
  currentValue: number;
  changePercent: number;
}

const ENSURE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS public.regression_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    agent_name TEXT NOT NULL,
    metric TEXT NOT NULL,
    baseline_value REAL NOT NULL,
    current_value REAL NOT NULL,
    change_percent REAL NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

function computeMetrics(
  rows: Array<{
    status: string;
    duration_ms: number | null;
    total_input_tokens: number;
    total_output_tokens: number;
    spans: Span[];
  }>
): AgentMetrics {
  if (rows.length === 0) {
    return {
      avgResponseLength: 0,
      avgTokenCount: 0,
      errorRate: 0,
      avgLatencyMs: 0,
      toolCallRatio: 0,
      traceCount: 0,
    };
  }

  let totalResponseLength = 0;
  let llmSpanCount = 0;
  let totalTokens = 0;
  let totalLatency = 0;
  let latencyCount = 0;
  let errorCount = 0;
  let totalSpans = 0;
  let toolCallSpans = 0;

  for (const row of rows) {
    totalTokens += (row.total_input_tokens ?? 0) + (row.total_output_tokens ?? 0);

    if (row.duration_ms != null) {
      totalLatency += row.duration_ms;
      latencyCount++;
    }

    if (row.status === "error") {
      errorCount++;
    }

    const spans: Span[] = Array.isArray(row.spans) ? row.spans : [];
    totalSpans += spans.length;

    for (const span of spans) {
      if (span.type === "tool_call") {
        toolCallSpans++;
      }
      if (span.type === "llm_call" && span.output?.content) {
        totalResponseLength += span.output.content.length;
        llmSpanCount++;
      }
    }
  }

  return {
    avgResponseLength: llmSpanCount > 0 ? totalResponseLength / llmSpanCount : 0,
    avgTokenCount: totalTokens / rows.length,
    errorRate: errorCount / rows.length,
    avgLatencyMs: latencyCount > 0 ? totalLatency / latencyCount : 0,
    toolCallRatio: totalSpans > 0 ? toolCallSpans / totalSpans : 0,
    traceCount: rows.length,
  };
}

function detectRegressions(
  baseline: AgentMetrics,
  current: AgentMetrics
): RegressionFlag[] {
  if (baseline.traceCount === 0 || current.traceCount === 0) {
    return [];
  }

  const flags: RegressionFlag[] = [];

  const checks: Array<{ metric: string; baselineVal: number; currentVal: number }> = [
    { metric: "avg_response_length", baselineVal: baseline.avgResponseLength, currentVal: current.avgResponseLength },
    { metric: "avg_token_count", baselineVal: baseline.avgTokenCount, currentVal: current.avgTokenCount },
    { metric: "error_rate", baselineVal: baseline.errorRate, currentVal: current.errorRate },
    { metric: "avg_latency_ms", baselineVal: baseline.avgLatencyMs, currentVal: current.avgLatencyMs },
    { metric: "tool_call_ratio", baselineVal: baseline.toolCallRatio, currentVal: current.toolCallRatio },
  ];

  for (const { metric, baselineVal, currentVal } of checks) {
    if (baselineVal === 0 && currentVal === 0) continue;
    const denominator = baselineVal === 0 ? 1 : baselineVal;
    const changePercent = (currentVal - baselineVal) / denominator;
    if (Math.abs(changePercent) > REGRESSION_THRESHOLD) {
      flags.push({
        metric,
        baselineValue: baselineVal,
        currentValue: currentVal,
        changePercent: Math.round(changePercent * 10000) / 100, // percent with 2 decimals
      });
    }
  }

  return flags;
}

export function registerRegressionRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // Ensure the regression_events table exists on startup
  pool.query(ENSURE_TABLE_SQL).catch((err) => {
    // Log but don't crash — table may already exist
    console.error("Failed to create regression_events table:", err);
  });

  // GET /regressions/check — analyze all agents for behavioral regressions
  app.get("/regressions/check", async (request, reply) => {
    const user = getUser(request);
    const schema = `tenant_${user.tenantSlug}`;

    const now = Date.now();
    const recentStart = now - RECENT_WINDOW_MS;
    const baselineStart = now - RECENT_WINDOW_MS - BASELINE_WINDOW_MS;
    const baselineEnd = now - RECENT_WINDOW_MS;

    try {
      // Get all distinct agent names
      const { rows: agents } = await pool.query(
        `SELECT DISTINCT agent_name FROM "${schema}".traces`
      );

      const results: Array<{
        agentName: string;
        baselineMetrics: AgentMetrics;
        currentMetrics: AgentMetrics;
        regressions: RegressionFlag[];
        hasRegression: boolean;
      }> = [];

      for (const agent of agents) {
        const agentName = agent.agent_name as string;

        // Fetch baseline traces (previous 7 days, ending 24h ago)
        const { rows: baselineRows } = await pool.query(
          `SELECT status, duration_ms, total_input_tokens, total_output_tokens, spans
           FROM "${schema}".traces
           WHERE agent_name = $1
             AND start_time >= $2
             AND start_time < $3`,
          [agentName, baselineStart, baselineEnd]
        );

        // Fetch recent traces (last 24h)
        const { rows: recentRows } = await pool.query(
          `SELECT status, duration_ms, total_input_tokens, total_output_tokens, spans
           FROM "${schema}".traces
           WHERE agent_name = $1
             AND start_time >= $2`,
          [agentName, recentStart]
        );

        const baselineMetrics = computeMetrics(baselineRows);
        const currentMetrics = computeMetrics(recentRows);
        const regressions = detectRegressions(baselineMetrics, currentMetrics);

        // Persist detected regressions
        for (const reg of regressions) {
          await pool.query(
            `INSERT INTO public.regression_events
               (tenant_id, agent_name, metric, baseline_value, current_value, change_percent)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [user.tenantId, agentName, reg.metric, reg.baselineValue, reg.currentValue, reg.changePercent]
          );
        }

        results.push({
          agentName,
          baselineMetrics,
          currentMetrics,
          regressions,
          hasRegression: regressions.length > 0,
        });
      }

      return reply.send({
        checkedAt: new Date().toISOString(),
        agentCount: results.length,
        regressionsFound: results.filter((r) => r.hasRegression).length,
        agents: results,
      });
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /regressions/history — list past detected regressions
  app.get<{ Querystring: { limit?: string; offset?: string; agentName?: string } }>(
    "/regressions/history",
    async (request, reply) => {
      const user = getUser(request);
      const limit = Math.min(parseInt(request.query.limit ?? "50", 10) || 50, 200);
      const offset = parseInt(request.query.offset ?? "0", 10) || 0;
      const agentName = request.query.agentName;

      try {
        let query = `
          SELECT id, agent_name, metric, baseline_value, current_value, change_percent, detected_at
          FROM public.regression_events
          WHERE tenant_id = $1
        `;
        const params: unknown[] = [user.tenantId];

        if (agentName) {
          params.push(agentName);
          query += ` AND agent_name = $${params.length}`;
        }

        query += ` ORDER BY detected_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const { rows } = await pool.query(query, params);

        // Get total count for pagination
        let countQuery = `SELECT COUNT(*) FROM public.regression_events WHERE tenant_id = $1`;
        const countParams: unknown[] = [user.tenantId];
        if (agentName) {
          countParams.push(agentName);
          countQuery += ` AND agent_name = $${countParams.length}`;
        }
        const { rows: countRows } = await pool.query(countQuery, countParams);
        const total = parseInt(countRows[0].count as string, 10);

        return reply.send({
          events: rows,
          total,
          limit,
          offset,
        });
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );

  // POST /regressions/baseline/:agentName — manually snapshot a baseline for an agent
  app.post<{ Params: { agentName: string } }>(
    "/regressions/baseline/:agentName",
    async (request, reply) => {
      const user = getUser(request);
      const schema = `tenant_${user.tenantSlug}`;
      const { agentName } = request.params;

      const now = Date.now();
      const windowStart = now - BASELINE_WINDOW_MS;

      try {
        const { rows } = await pool.query(
          `SELECT status, duration_ms, total_input_tokens, total_output_tokens, spans
           FROM "${schema}".traces
           WHERE agent_name = $1
             AND start_time >= $2`,
          [agentName, windowStart]
        );

        if (rows.length === 0) {
          return reply.status(404).send({
            error: `No traces found for agent "${agentName}" in the last 7 days`,
          });
        }

        const metrics = computeMetrics(rows);

        return reply.send({
          agentName,
          snapshotAt: new Date().toISOString(),
          traceCount: rows.length,
          windowDays: 7,
          baseline: metrics,
        });
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );
}
