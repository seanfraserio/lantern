import type pg from "pg";

interface UsageIncrement {
  traceCount: number;
  inputTokens: number;
  outputTokens: number;
}

export class UsageBuffer {
  private buffer: Map<string, UsageIncrement> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pool: pg.Pool;
  private flushThreshold: number;

  constructor(pool: pg.Pool, opts?: { flushIntervalMs?: number; flushThreshold?: number }) {
    this.pool = pool;
    this.flushThreshold = opts?.flushThreshold ?? 100;
    const intervalMs = opts?.flushIntervalMs ?? 30_000;

    this.timer = setInterval(() => {
      this.flush().catch(console.error);
    }, intervalMs);
    this.timer.unref();
  }

  increment(tenantId: string, traces: number, inputTokens: number, outputTokens: number): void {
    const existing = this.buffer.get(tenantId) ?? { traceCount: 0, inputTokens: 0, outputTokens: 0 };
    existing.traceCount += traces;
    existing.inputTokens += inputTokens;
    existing.outputTokens += outputTokens;
    this.buffer.set(tenantId, existing);

    const total = Array.from(this.buffer.values()).reduce((s, v) => s + v.traceCount, 0);
    if (total >= this.flushThreshold) {
      this.flush().catch(console.error);
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.size === 0) return;

    const entries = new Map(this.buffer);
    this.buffer.clear();

    const month = new Date().toISOString().slice(0, 7);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [tenantId, inc] of entries) {
        await client.query(
          `INSERT INTO public.usage (id, tenant_id, month, trace_count, input_tokens, output_tokens)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, month)
           DO UPDATE SET
             trace_count = usage.trace_count + $3,
             input_tokens = usage.input_tokens + $4,
             output_tokens = usage.output_tokens + $5`,
          [tenantId, month, inc.traceCount, inc.inputTokens, inc.outputTokens]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      for (const [tenantId, inc] of entries) {
        const existing = this.buffer.get(tenantId) ?? { traceCount: 0, inputTokens: 0, outputTokens: 0 };
        existing.traceCount += inc.traceCount;
        existing.inputTokens += inc.inputTokens;
        existing.outputTokens += inc.outputTokens;
        this.buffer.set(tenantId, existing);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
