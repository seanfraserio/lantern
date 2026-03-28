import { PubSub, type Topic } from "@google-cloud/pubsub";
import type { ITraceExporter, Trace } from "../types.js";

export interface PubSubExporterConfig {
  topicName: string;
  projectId?: string;
  tenantId?: string;
}

/**
 * Exports traces to a Google Cloud Pub/Sub topic as a JSON batch.
 *
 * Unlike fire-and-forget patterns used in server-side consumers, this
 * exporter propagates publish errors so the tracer can re-buffer and retry.
 *
 * Message shape:
 *   data        — JSON Buffer: { traces: Trace[] }
 *   orderingKey — traces[0].agentName (keeps a single agent's traces ordered)
 *   attributes  — agentName, environment, traceCount, tenantId (if set)
 */
export class PubSubExporter implements ITraceExporter {
  readonly exporterType = "pubsub";

  private readonly pubsub: PubSub;
  private readonly topic: Topic;
  private readonly tenantId?: string;

  constructor(config: PubSubExporterConfig) {
    this.pubsub = new PubSub({ projectId: config.projectId });
    this.topic = this.pubsub.topic(config.topicName);
    this.tenantId = config.tenantId;
  }

  async export(traces: Trace[]): Promise<void> {
    const data = Buffer.from(JSON.stringify({ traces }), "utf8");
    const orderingKey = traces[0]?.agentName;

    const attributes: Record<string, string> = {
      agentName: traces[0]?.agentName ?? "",
      environment: traces[0]?.environment ?? "",
      traceCount: String(traces.length),
    };

    if (this.tenantId !== undefined) {
      attributes.tenantId = this.tenantId;
    }

    await this.topic.publishMessage({ data, orderingKey, attributes });
  }

  async shutdown(): Promise<void> {
    await this.topic.flush();
    await this.pubsub.close();
  }
}
