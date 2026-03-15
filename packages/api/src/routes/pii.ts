import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getUser } from "../middleware/jwt.js";

// Dynamic import helper to avoid hard compile-time dependency on the enterprise package.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPiiDetector(): Promise<any> {
  const mod = await (Function('return import("@lantern-ai/enterprise")')() as Promise<Record<string, unknown>>);
  return new (mod.PiiDetector as new () => { scan: (t: string) => unknown[]; redact: (t: string) => string })();
}

/**
 * PII scanning routes. Scans trace content for personally identifiable information.
 */
export function registerPiiRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // POST /pii/scan — scan text for PII
  app.post<{ Body: { text: string } }>("/pii/scan", async (request, reply) => {
    getUser(request); // require auth

    const { text } = request.body;
    if (!text) return reply.status(400).send({ error: "text is required" });

    try {
      const detector = await loadPiiDetector();
      const detections = detector.scan(text);
      return reply.send({ detections });
    } catch {
      return reply.status(501).send({ error: "PII detection not available" });
    }
  });

  // POST /pii/redact — redact PII from text
  app.post<{ Body: { text: string } }>("/pii/redact", async (request, reply) => {
    getUser(request);

    const { text } = request.body;
    if (!text) return reply.status(400).send({ error: "text is required" });

    try {
      const detector = await loadPiiDetector();
      const redacted = detector.redact(text);
      return reply.send({ redacted });
    } catch {
      return reply.status(501).send({ error: "PII detection not available" });
    }
  });

  // POST /pii/scan-trace/:id — scan a trace's content for PII
  app.post<{ Params: { id: string } }>("/pii/scan-trace/:id", async (request, reply) => {
    const user = getUser(request);
    const schema = `tenant_${user.tenantSlug}`;

    try {
      const { rows } = await pool.query(
        `SELECT spans, metadata FROM "${schema}".traces WHERE id = $1`,
        [request.params.id]
      );
      if (rows.length === 0) return reply.status(404).send({ error: "Trace not found" });

      const detector = await loadPiiDetector();

      // Scan all text content in spans
      const spans = rows[0].spans as Array<Record<string, unknown>>;
      const allDetections: Array<{ spanId: string; field: string; detections: unknown[] }> = [];

      for (const span of spans) {
        const spanId = span.id as string;

        // Scan input messages
        const input = span.input as Record<string, unknown> | undefined;
        if (input?.messages) {
          const messages = input.messages as Array<{ content: string }>;
          for (const msg of messages) {
            if (msg.content) {
              const d = detector.scan(msg.content);
              if (d.length > 0) allDetections.push({ spanId, field: "input", detections: d });
            }
          }
        }

        // Scan output content
        const output = span.output as Record<string, unknown> | undefined;
        if (output?.content && typeof output.content === "string") {
          const d = detector.scan(output.content);
          if (d.length > 0) allDetections.push({ spanId, field: "output", detections: d });
        }
      }

      return reply.send({
        traceId: request.params.id,
        piiFound: allDetections.length > 0,
        detections: allDetections,
      });
    } catch (err) {
      if ((err as Error).message?.includes("not available")) {
        return reply.status(501).send({ error: "PII detection not available" });
      }
      request.log.error(err);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
