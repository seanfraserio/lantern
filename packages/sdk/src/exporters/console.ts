import type { ITraceExporter, Trace } from "../types.js";

/**
 * Exports traces to stdout. Useful for development and debugging.
 */
export class ConsoleExporter implements ITraceExporter {
  readonly exporterType = "console";
  private verbose: boolean;

  constructor(opts?: { verbose?: boolean }) {
    this.verbose = opts?.verbose ?? false;
  }

  async export(traces: Trace[]): Promise<void> {
    for (const trace of traces) {
      console.log(`[lantern] Trace ${trace.id} | ${trace.agentName} | ${trace.status}`);
      console.log(`  Duration: ${trace.durationMs ?? "running"}ms`);
      console.log(`  Tokens: ${trace.totalInputTokens} in / ${trace.totalOutputTokens} out`);
      console.log(`  Cost: $${trace.estimatedCostUsd.toFixed(6)}`);
      console.log(`  Spans: ${trace.spans.length}`);

      if (this.verbose) {
        for (const span of trace.spans) {
          console.log(`    [${span.type}] ${span.id.slice(0, 8)}... ${span.durationMs ?? 0}ms`);
          if (span.model) console.log(`      Model: ${span.model}`);
          if (span.toolName) console.log(`      Tool: ${span.toolName}`);
          if (span.error) console.log(`      Error: ${span.error}`);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    // Nothing to shut down
  }
}
