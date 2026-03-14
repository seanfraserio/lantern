import type { ITraceExporter, Trace } from "../types.js";

export interface OtlpExporterConfig {
  endpoint: string;
  headers?: Record<string, string>;
}

/**
 * OpenTelemetry-compatible exporter.
 * Converts Lantern traces to OTLP format and exports via HTTP.
 */
export class OtlpExporter implements ITraceExporter {
  readonly exporterType = "otlp";
  constructor(private _config: OtlpExporterConfig) {}

  // TODO: Implement OTLP trace conversion and export
  async export(_traces: Trace[]): Promise<void> {
    console.warn("[lantern] OTLP exporter not yet implemented");
  }

  async shutdown(): Promise<void> {
    // TODO: Flush pending exports
  }
}
