import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getUser } from "../middleware/jwt.js";

const MODEL_PRICING: Record<string, { name: string; inputPer1k: number; outputPer1k: number }> = {
  "claude-sonnet-4-6": { name: "Claude Sonnet", inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-haiku-4-5-20251001": { name: "Claude Haiku", inputPer1k: 0.0008, outputPer1k: 0.004 },
  "gpt-4o": { name: "GPT-4o", inputPer1k: 0.005, outputPer1k: 0.015 },
  "gpt-4o-mini": { name: "GPT-4o Mini", inputPer1k: 0.00015, outputPer1k: 0.0006 },
};

export function registerCostRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // GET /costs/breakdown — cost breakdown by agent, model, and day for the current month
  app.get("/costs/breakdown", async (request, reply) => {
    const user = getUser(request);
    const schema = `tenant_${user.tenantSlug}`;

    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthStartMs = monthStart.getTime();

      // Per-agent breakdown
      const { rows: agentRows } = await pool.query(
        `SELECT
          agent_name,
          SUM(estimated_cost_usd)::real AS total_cost,
          COUNT(*)::int AS trace_count,
          AVG(estimated_cost_usd)::real AS avg_cost_per_trace,
          spans
        FROM "${schema}".traces
        WHERE start_time >= $1
        GROUP BY agent_name, spans
        ORDER BY total_cost DESC`,
        [monthStartMs]
      );

      // Aggregate agent data and find top model per agent
      const agentMap = new Map<string, {
        totalCost: number;
        traceCount: number;
        avgCostPerTrace: number;
        modelCounts: Map<string, number>;
      }>();

      for (const row of agentRows) {
        const name = row.agent_name as string;
        const existing = agentMap.get(name);
        const cost = row.total_cost as number;
        const count = row.trace_count as number;

        if (existing) {
          const newTotal = existing.traceCount + count;
          existing.totalCost += cost;
          existing.avgCostPerTrace =
            (existing.avgCostPerTrace * existing.traceCount + (row.avg_cost_per_trace as number) * count) / newTotal;
          existing.traceCount = newTotal;
        } else {
          agentMap.set(name, {
            totalCost: cost,
            traceCount: count,
            avgCostPerTrace: row.avg_cost_per_trace as number,
            modelCounts: new Map(),
          });
        }

        const entry = agentMap.get(name)!;
        const spans = row.spans as Array<{ type?: string; model?: string }> | null;
        if (Array.isArray(spans)) {
          for (const span of spans) {
            if (span.type === "llm_call" && span.model) {
              entry.modelCounts.set(span.model, (entry.modelCounts.get(span.model) ?? 0) + 1);
            }
          }
        }
      }

      const perAgent = Array.from(agentMap.entries()).map(([agentName, data]) => {
        let topModel: string | null = null;
        let maxCount = 0;
        for (const [model, count] of data.modelCounts) {
          if (count > maxCount) {
            maxCount = count;
            topModel = model;
          }
        }
        return {
          agentName,
          totalCost: data.totalCost,
          traceCount: data.traceCount,
          avgCostPerTrace: data.avgCostPerTrace,
          topModel,
        };
      }).sort((a, b) => b.totalCost - a.totalCost);

      // Per-model breakdown — parse spans JSONB for model names and tokens
      const { rows: modelRows } = await pool.query(
        `SELECT
          span->>'model' AS model,
          SUM(estimated_cost_usd)::real AS total_cost,
          SUM((span->>'inputTokens')::int) AS total_input_tokens,
          SUM((span->>'outputTokens')::int) AS total_output_tokens
        FROM "${schema}".traces,
          jsonb_array_elements(spans) AS span
        WHERE start_time >= $1
          AND span->>'type' = 'llm_call'
          AND span->>'model' IS NOT NULL
        GROUP BY span->>'model'
        ORDER BY total_cost DESC`,
        [monthStartMs]
      );

      const perModel = modelRows.map((row) => ({
        model: row.model as string,
        totalCost: (row.total_cost as number) ?? 0,
        totalTokens: ((row.total_input_tokens as number) ?? 0) + ((row.total_output_tokens as number) ?? 0),
      }));

      // Daily time series
      const { rows: dailyRows } = await pool.query(
        `SELECT
          to_char(to_timestamp(start_time / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
          SUM(estimated_cost_usd)::real AS cost,
          COUNT(*)::int AS trace_count
        FROM "${schema}".traces
        WHERE start_time >= $1
        GROUP BY date
        ORDER BY date ASC`,
        [monthStartMs]
      );

      const daily = dailyRows.map((row) => ({
        date: row.date as string,
        cost: row.cost as number,
        traceCount: row.trace_count as number,
      }));

      return reply.send({ perAgent, perModel, daily });
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Failed to compute cost breakdown" });
    }
  });

  // GET /costs/forecast — project end-of-month cost based on current trajectory
  app.get("/costs/forecast", async (request, reply) => {
    const user = getUser(request);
    const schema = `tenant_${user.tenantSlug}`;

    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      const monthStart = new Date(year, month, 1);
      const monthStartMs = monthStart.getTime();

      // Days elapsed (at least 1 to avoid division by zero)
      const dayOfMonth = now.getDate();
      const daysElapsed = Math.max(1, dayOfMonth);
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const daysRemaining = daysInMonth - dayOfMonth;

      // Current month spend
      const { rows: currentRows } = await pool.query(
        `SELECT
          COALESCE(SUM(estimated_cost_usd), 0)::real AS total_cost
        FROM "${schema}".traces
        WHERE start_time >= $1`,
        [monthStartMs]
      );
      const currentSpend = (currentRows[0]?.total_cost as number) ?? 0;
      const dailyAvg = currentSpend / daysElapsed;
      const projectedTotal = currentSpend + dailyAvg * daysRemaining;

      // Last month spend for comparison
      const lastMonthStart = new Date(year, month - 1, 1);
      const lastMonthStartMs = lastMonthStart.getTime();
      const { rows: lastMonthRows } = await pool.query(
        `SELECT
          COALESCE(SUM(estimated_cost_usd), 0)::real AS total_cost
        FROM "${schema}".traces
        WHERE start_time >= $1 AND start_time < $2`,
        [lastMonthStartMs, monthStartMs]
      );
      const lastMonthSpend = (lastMonthRows[0]?.total_cost as number) ?? 0;

      // Per-agent forecast
      const { rows: agentForecastRows } = await pool.query(
        `SELECT
          agent_name,
          COALESCE(SUM(estimated_cost_usd), 0)::real AS current_spend
        FROM "${schema}".traces
        WHERE start_time >= $1
        GROUP BY agent_name
        ORDER BY current_spend DESC`,
        [monthStartMs]
      );

      const perAgent = agentForecastRows.map((row) => {
        const agentSpend = row.current_spend as number;
        const agentDailyAvg = agentSpend / daysElapsed;
        return {
          agentName: row.agent_name as string,
          currentSpend: agentSpend,
          dailyAverage: agentDailyAvg,
          projectedTotal: agentSpend + agentDailyAvg * daysRemaining,
        };
      });

      return reply.send({
        currentMonthSpend: currentSpend,
        dailyAverage: dailyAvg,
        daysElapsed,
        daysRemaining,
        projectedMonthlyTotal: projectedTotal,
        lastMonthSpend,
        monthOverMonthChange: lastMonthSpend > 0
          ? ((projectedTotal - lastMonthSpend) / lastMonthSpend) * 100
          : null,
        perAgent,
      });
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Failed to compute cost forecast" });
    }
  });

  // POST /costs/budget — set a monthly budget for an agent
  app.post<{ Body: { agentName: string; monthlyBudget: number } }>(
    "/costs/budget",
    async (request, reply) => {
      const user = getUser(request);
      const { agentName, monthlyBudget } = request.body;

      if (!agentName || typeof agentName !== "string") {
        return reply.status(400).send({ error: "agentName is required" });
      }
      if (monthlyBudget == null || typeof monthlyBudget !== "number" || monthlyBudget <= 0) {
        return reply.status(400).send({ error: "monthlyBudget must be a positive number" });
      }

      try {
        // Ensure table exists
        await pool.query(`
          CREATE TABLE IF NOT EXISTS public.cost_budgets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id UUID NOT NULL,
            agent_name TEXT NOT NULL,
            monthly_budget REAL NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE(tenant_id, agent_name)
          )
        `);

        await pool.query(
          `INSERT INTO public.cost_budgets (tenant_id, agent_name, monthly_budget)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, agent_name)
           DO UPDATE SET monthly_budget = $3`,
          [user.tenantId, agentName, monthlyBudget]
        );

        return reply.send({
          success: true,
          agentName,
          monthlyBudget,
        });
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Failed to set budget" });
      }
    }
  );

  // GET /costs/budget/alerts — check which agents are trending to exceed their budget
  app.get("/costs/budget/alerts", async (request, reply) => {
    const user = getUser(request);
    const schema = `tenant_${user.tenantSlug}`;

    try {
      // Ensure table exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.cost_budgets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL,
          agent_name TEXT NOT NULL,
          monthly_budget REAL NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(tenant_id, agent_name)
        )
      `);

      // Get all budgets for this tenant
      const { rows: budgets } = await pool.query(
        `SELECT agent_name, monthly_budget FROM public.cost_budgets WHERE tenant_id = $1`,
        [user.tenantId]
      );

      if (budgets.length === 0) {
        return reply.send({ alerts: [] });
      }

      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      const monthStart = new Date(year, month, 1);
      const monthStartMs = monthStart.getTime();
      const daysElapsed = Math.max(1, now.getDate());
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const daysRemaining = daysInMonth - now.getDate();

      // Get current spend and top model per agent for this month
      const agentNames = budgets.map((b) => b.agent_name as string);
      const { rows: spendRows } = await pool.query(
        `SELECT
          agent_name,
          COALESCE(SUM(estimated_cost_usd), 0)::real AS current_spend,
          spans
        FROM "${schema}".traces
        WHERE start_time >= $1 AND agent_name = ANY($2)
        GROUP BY agent_name, spans`,
        [monthStartMs, agentNames]
      );

      // Aggregate per-agent spend and collect model usage
      const agentSpend = new Map<string, { spend: number; modelCounts: Map<string, number> }>();
      for (const row of spendRows) {
        const name = row.agent_name as string;
        const existing = agentSpend.get(name);
        const cost = row.current_spend as number;

        if (existing) {
          existing.spend += cost;
        } else {
          agentSpend.set(name, { spend: cost, modelCounts: new Map() });
        }

        const entry = agentSpend.get(name)!;
        const spans = row.spans as Array<{ type?: string; model?: string }> | null;
        if (Array.isArray(spans)) {
          for (const span of spans) {
            if (span.type === "llm_call" && span.model) {
              entry.modelCounts.set(span.model, (entry.modelCounts.get(span.model) ?? 0) + 1);
            }
          }
        }
      }

      const alerts = [];

      for (const budget of budgets) {
        const agentName = budget.agent_name as string;
        const monthlyBudget = budget.monthly_budget as number;
        const data = agentSpend.get(agentName);
        const currentSpend = data?.spend ?? 0;
        const dailyAvg = currentSpend / daysElapsed;
        const projectedSpend = currentSpend + dailyAvg * daysRemaining;
        const percentOfBudget = monthlyBudget > 0
          ? Math.round((projectedSpend / monthlyBudget) * 100)
          : 0;

        if (projectedSpend > monthlyBudget) {
          // Find the most used model
          let topModel: string | null = null;
          let maxCount = 0;
          if (data) {
            for (const [model, count] of data.modelCounts) {
              if (count > maxCount) {
                maxCount = count;
                topModel = model;
              }
            }
          }

          // Generate recommendation
          let recommendation: string | null = null;
          if (topModel) {
            const currentPricing = MODEL_PRICING[topModel];
            if (currentPricing) {
              // Find a cheaper alternative
              const cheaper = Object.entries(MODEL_PRICING)
                .filter(([key]) => key !== topModel)
                .sort((a, b) => a[1].inputPer1k - b[1].inputPer1k);

              const cheaperOption = cheaper.find(
                ([, pricing]) => pricing.inputPer1k < currentPricing.inputPer1k
              );
              if (cheaperOption) {
                const savings = Math.round(
                  (1 - cheaperOption[1].inputPer1k / currentPricing.inputPer1k) * 100
                );
                recommendation =
                  `Consider switching from ${currentPricing.name} to ${cheaperOption[1].name} ` +
                  `to save ~${savings}% on input costs.`;
              }
            } else {
              // Unknown model — suggest cheapest known model
              const cheapest = Object.entries(MODEL_PRICING).sort(
                (a, b) => a[1].inputPer1k - b[1].inputPer1k
              )[0];
              if (cheapest) {
                recommendation =
                  `Consider using ${cheapest[1].name} (${cheapest[0]}) for lower-cost operations.`;
              }
            }
          }

          alerts.push({
            agentName,
            budget: monthlyBudget,
            currentSpend,
            projectedSpend,
            percentOfBudget,
            recommendation,
          });
        }
      }

      return reply.send({ alerts });
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Failed to check budget alerts" });
    }
  });
}
