import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getUser } from "../middleware/jwt.js";

// ── Types ──────────────────────────────────────────────────────────────

interface AgentScorecard {
  agentName: string;
  totalTraces: number;
  successRate: number;
  errorRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgCostPerTrace: number;
  totalCost: number;
  qualityTrend: "improving" | "stable" | "declining";
}

interface DailyBreakdown {
  date: string;
  totalTraces: number;
  successRate: number;
  errorRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgCostPerTrace: number;
  totalCost: number;
}

interface SlaTarget {
  id: string;
  tenantId: string;
  agentName: string;
  minSuccessRate: number | null;
  maxP95LatencyMs: number | null;
  maxCostPerTrace: number | null;
  createdAt: string;
}

interface SlaViolation {
  agentName: string;
  sla: SlaTarget;
  current: {
    successRate: number;
    p95LatencyMs: number;
    avgCostPerTrace: number;
  };
  violations: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────

const VALID_PERIODS = [7, 30, 90];

function parsePeriod(raw: unknown): number {
  const n = Number(raw);
  if (VALID_PERIODS.includes(n)) return n;
  return 30;
}

function cutoffMs(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

// ── Init ───────────────────────────────────────────────────────────────

export async function initSlaTargetsTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.sla_targets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      agent_name TEXT NOT NULL,
      min_success_rate REAL,
      max_p95_latency_ms INTEGER,
      max_cost_per_trace REAL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(tenant_id, agent_name)
    )
  `);
}

// ── Routes ─────────────────────────────────────────────────────────────

export function registerScorecardRoutes(app: FastifyInstance, pool: pg.Pool): void {

  // ── GET /scorecards ─────────────────────────────────────────────────
  app.get<{ Querystring: { period?: string; environment?: string } }>(
    "/scorecards",
    async (request, reply) => {
      const user = getUser(request);
      const schema = `tenant_${user.tenantSlug}`;
      const period = parsePeriod(request.query.period);
      const env = request.query.environment;
      const now = Date.now();
      const currentCutoff = cutoffMs(period);
      const previousCutoff = now - period * 2 * 24 * 60 * 60 * 1000;

      const envFilter = env ? "AND environment = $3" : "";
      const params: unknown[] = [currentCutoff, previousCutoff];
      if (env) params.push(env);

      try {
        // Current period scorecards
        const { rows: current } = await pool.query(
          `SELECT
             agent_name,
             COUNT(*)::int AS total_traces,
             ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'success') / NULLIF(COUNT(*), 0), 2) AS success_rate,
             ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'error') / NULLIF(COUNT(*), 0), 2) AS error_rate,
             ROUND(AVG(duration_ms)::numeric, 2) AS avg_latency_ms,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_latency_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_latency_ms,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_latency_ms,
             ROUND(AVG(estimated_cost_usd)::numeric, 6) AS avg_cost_per_trace,
             ROUND(SUM(estimated_cost_usd)::numeric, 6) AS total_cost
           FROM "${schema}".traces
           WHERE start_time >= $1 ${envFilter}
           GROUP BY agent_name
           ORDER BY agent_name`,
          env ? [currentCutoff, env] : [currentCutoff]
        );

        // Previous period for trend comparison
        const { rows: previous } = await pool.query(
          `SELECT
             agent_name,
             ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'success') / NULLIF(COUNT(*), 0), 2) AS success_rate
           FROM "${schema}".traces
           WHERE start_time >= $1 AND start_time < $2 ${envFilter}
           GROUP BY agent_name`,
          env ? [previousCutoff, currentCutoff, env] : [previousCutoff, currentCutoff]
        );

        const prevMap = new Map(previous.map((r) => [r.agent_name, Number(r.success_rate)]));

        const scorecards: AgentScorecard[] = current.map((row) => {
          const curRate = Number(row.success_rate);
          const prevRate = prevMap.get(row.agent_name as string);
          let qualityTrend: AgentScorecard["qualityTrend"] = "stable";
          if (prevRate !== undefined) {
            if (curRate - prevRate > 1) qualityTrend = "improving";
            else if (prevRate - curRate > 1) qualityTrend = "declining";
          }

          return {
            agentName: row.agent_name as string,
            totalTraces: row.total_traces as number,
            successRate: Number(row.success_rate),
            errorRate: Number(row.error_rate),
            avgLatencyMs: Number(row.avg_latency_ms),
            p50LatencyMs: Number(row.p50_latency_ms),
            p95LatencyMs: Number(row.p95_latency_ms),
            p99LatencyMs: Number(row.p99_latency_ms),
            avgCostPerTrace: Number(row.avg_cost_per_trace),
            totalCost: Number(row.total_cost),
            qualityTrend,
          };
        });

        return { period, scorecards };
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Failed to generate scorecards" });
      }
    }
  );

  // ── GET /scorecards/:agentName ──────────────────────────────────────
  app.get<{ Params: { agentName: string }; Querystring: { period?: string; environment?: string } }>(
    "/scorecards/:agentName",
    async (request, reply) => {
      const user = getUser(request);
      const schema = `tenant_${user.tenantSlug}`;
      const { agentName } = request.params;
      const period = parsePeriod(request.query.period);
      const env = request.query.environment;
      const start = cutoffMs(period);

      const envFilter = env ? "AND environment = $3" : "";
      const baseParams: unknown[] = env ? [agentName, start, env] : [agentName, start];

      try {
        // Overall summary
        const { rows: summaryRows } = await pool.query(
          `SELECT
             COUNT(*)::int AS total_traces,
             ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'success') / NULLIF(COUNT(*), 0), 2) AS success_rate,
             ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'error') / NULLIF(COUNT(*), 0), 2) AS error_rate,
             ROUND(AVG(duration_ms)::numeric, 2) AS avg_latency_ms,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_latency_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_latency_ms,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_latency_ms,
             ROUND(AVG(estimated_cost_usd)::numeric, 6) AS avg_cost_per_trace,
             ROUND(SUM(estimated_cost_usd)::numeric, 6) AS total_cost
           FROM "${schema}".traces
           WHERE agent_name = $1 AND start_time >= $2 ${envFilter}`,
          baseParams
        );

        if (summaryRows.length === 0 || summaryRows[0].total_traces === 0) {
          return reply.status(404).send({ error: "No traces found for this agent in the given period" });
        }

        const summary = summaryRows[0];

        // Daily breakdown
        const { rows: dailyRows } = await pool.query(
          `SELECT
             to_char(to_timestamp(start_time / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS total_traces,
             ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'success') / NULLIF(COUNT(*), 0), 2) AS success_rate,
             ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'error') / NULLIF(COUNT(*), 0), 2) AS error_rate,
             ROUND(AVG(duration_ms)::numeric, 2) AS avg_latency_ms,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_latency_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_latency_ms,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_latency_ms,
             ROUND(AVG(estimated_cost_usd)::numeric, 6) AS avg_cost_per_trace,
             ROUND(SUM(estimated_cost_usd)::numeric, 6) AS total_cost
           FROM "${schema}".traces
           WHERE agent_name = $1 AND start_time >= $2 ${envFilter}
           GROUP BY date
           ORDER BY date`,
          baseParams
        );

        const daily: DailyBreakdown[] = dailyRows.map((row) => ({
          date: row.date as string,
          totalTraces: row.total_traces as number,
          successRate: Number(row.success_rate),
          errorRate: Number(row.error_rate),
          avgLatencyMs: Number(row.avg_latency_ms),
          p50LatencyMs: Number(row.p50_latency_ms),
          p95LatencyMs: Number(row.p95_latency_ms),
          p99LatencyMs: Number(row.p99_latency_ms),
          avgCostPerTrace: Number(row.avg_cost_per_trace),
          totalCost: Number(row.total_cost),
        }));

        return {
          agentName,
          period,
          summary: {
            totalTraces: summary.total_traces as number,
            successRate: Number(summary.success_rate),
            errorRate: Number(summary.error_rate),
            avgLatencyMs: Number(summary.avg_latency_ms),
            p50LatencyMs: Number(summary.p50_latency_ms),
            p95LatencyMs: Number(summary.p95_latency_ms),
            p99LatencyMs: Number(summary.p99_latency_ms),
            avgCostPerTrace: Number(summary.avg_cost_per_trace),
            totalCost: Number(summary.total_cost),
          },
          daily,
        };
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Failed to generate agent scorecard" });
      }
    }
  );

  // ── POST /scorecards/sla ────────────────────────────────────────────
  app.post<{
    Body: {
      agentName: string;
      minSuccessRate?: number;
      maxP95LatencyMs?: number;
      maxCostPerTrace?: number;
    };
  }>(
    "/scorecards/sla",
    async (request, reply) => {
      const user = getUser(request);
      const { agentName, minSuccessRate, maxP95LatencyMs, maxCostPerTrace } = request.body;

      if (!agentName) {
        return reply.status(400).send({ error: "agentName is required" });
      }

      if (minSuccessRate === undefined && maxP95LatencyMs === undefined && maxCostPerTrace === undefined) {
        return reply.status(400).send({ error: "At least one SLA target is required" });
      }

      try {
        const { rows } = await pool.query(
          `INSERT INTO public.sla_targets (tenant_id, agent_name, min_success_rate, max_p95_latency_ms, max_cost_per_trace)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
             min_success_rate = COALESCE(EXCLUDED.min_success_rate, sla_targets.min_success_rate),
             max_p95_latency_ms = COALESCE(EXCLUDED.max_p95_latency_ms, sla_targets.max_p95_latency_ms),
             max_cost_per_trace = COALESCE(EXCLUDED.max_cost_per_trace, sla_targets.max_cost_per_trace)
           RETURNING *`,
          [
            user.tenantId,
            agentName,
            minSuccessRate ?? null,
            maxP95LatencyMs ?? null,
            maxCostPerTrace ?? null,
          ]
        );

        const row = rows[0];
        return reply.status(201).send({
          slaTarget: {
            id: row.id as string,
            tenantId: row.tenant_id as string,
            agentName: row.agent_name as string,
            minSuccessRate: row.min_success_rate as number | null,
            maxP95LatencyMs: row.max_p95_latency_ms as number | null,
            maxCostPerTrace: row.max_cost_per_trace as number | null,
            createdAt: (row.created_at as Date).toISOString(),
          } satisfies SlaTarget,
        });
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Failed to set SLA target" });
      }
    }
  );

  // ── GET /scorecards/sla/violations ──────────────────────────────────
  app.get<{ Querystring: { period?: string; environment?: string } }>(
    "/scorecards/sla/violations",
    async (request, reply) => {
      const user = getUser(request);
      const schema = `tenant_${user.tenantSlug}`;
      const period = parsePeriod(request.query.period);
      const env = request.query.environment;
      const start = cutoffMs(period);

      try {
        // Get all SLA targets for this tenant
        const { rows: targets } = await pool.query(
          `SELECT * FROM public.sla_targets WHERE tenant_id = $1`,
          [user.tenantId]
        );

        if (targets.length === 0) {
          return { violations: [], message: "No SLA targets configured" };
        }

        // Get current metrics for all agents that have SLA targets
        const agentNames = targets.map((t) => t.agent_name as string);
        const envFilter = env ? `AND environment = $3` : "";
        const metricsParams: unknown[] = env ? [start, agentNames, env] : [start, agentNames];

        const { rows: metrics } = await pool.query(
          `SELECT
             agent_name,
             ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'success') / NULLIF(COUNT(*), 0), 2) AS success_rate,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_latency_ms,
             ROUND(AVG(estimated_cost_usd)::numeric, 6) AS avg_cost_per_trace
           FROM "${schema}".traces
           WHERE start_time >= $1 AND agent_name = ANY($2) ${envFilter}
           GROUP BY agent_name`,
          metricsParams
        );

        const metricsMap = new Map(
          metrics.map((m) => [
            m.agent_name as string,
            {
              successRate: Number(m.success_rate),
              p95LatencyMs: Number(m.p95_latency_ms),
              avgCostPerTrace: Number(m.avg_cost_per_trace),
            },
          ])
        );

        const violations: SlaViolation[] = [];

        for (const target of targets) {
          const agentName = target.agent_name as string;
          const current = metricsMap.get(agentName);
          if (!current) continue;

          const issues: string[] = [];

          const minSuccessRate = target.min_success_rate as number | null;
          if (minSuccessRate !== null && current.successRate < minSuccessRate) {
            issues.push(
              `Success rate ${current.successRate}% is below minimum ${minSuccessRate}%`
            );
          }

          const maxP95 = target.max_p95_latency_ms as number | null;
          if (maxP95 !== null && current.p95LatencyMs > maxP95) {
            issues.push(
              `P95 latency ${current.p95LatencyMs}ms exceeds maximum ${maxP95}ms`
            );
          }

          const maxCost = target.max_cost_per_trace as number | null;
          if (maxCost !== null && current.avgCostPerTrace > maxCost) {
            issues.push(
              `Avg cost per trace $${current.avgCostPerTrace} exceeds maximum $${maxCost}`
            );
          }

          if (issues.length > 0) {
            violations.push({
              agentName,
              sla: {
                id: target.id as string,
                tenantId: target.tenant_id as string,
                agentName,
                minSuccessRate: minSuccessRate,
                maxP95LatencyMs: maxP95,
                maxCostPerTrace: maxCost,
                createdAt: (target.created_at as Date).toISOString(),
              },
              current,
              violations: issues,
            });
          }
        }

        return { period, violations };
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Failed to check SLA violations" });
      }
    }
  );
}
