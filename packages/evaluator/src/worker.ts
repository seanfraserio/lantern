import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import type { ITraceStore, Scorer, EvalScore } from "@openlantern-ai/sdk";

export interface EvalWorkerConfig {
  store: ITraceStore;
  scorers: Scorer[];
}

interface EvaluateBody {
  traceId: string;
  agentName: string;
  tenantSchema?: string;
}

/**
 * Creates a Fastify HTTP server that Cloud Tasks calls to evaluate traces.
 * Receives a traceId, fetches the trace from the store, runs all scorers,
 * writes scores back to the trace, and returns the results.
 */
export async function createEvalWorker(config: EvalWorkerConfig): Promise<FastifyInstance> {
  const { store, scorers } = config;

  const app = Fastify({ logger: false });

  app.get("/health", async (_req, reply) => {
    return reply.send({ status: "ok" });
  });

  app.post<{ Body: EvaluateBody }>("/evaluate", async (req, reply) => {
    const { traceId } = req.body;

    const trace = await store.getTrace(traceId);
    if (!trace) {
      return reply.status(404).send({ error: "Trace not found" });
    }

    const scores: EvalScore[] = [];

    for (const scorer of scorers) {
      try {
        const result = await scorer.score(trace);
        scores.push(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        scores.push({
          scorer: scorer.name,
          score: 0,
          label: "error",
          reasoning: `Scorer failed: ${message}`,
        });
      }
    }

    await store.updateScores(trace.id, scores);

    return reply.send({ traceId, scores });
  });

  return app;
}
