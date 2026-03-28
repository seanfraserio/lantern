import { PubSub, type Subscription, type Message } from "@google-cloud/pubsub";
import type { ITraceStore, Trace } from "@openlantern-ai/sdk";

export interface PubSubTraceConsumerOptions {
  store: ITraceStore;
  subscriptionName?: string;
  projectId?: string;
  onInsert?: (traces: Trace[]) => void;
}

/**
 * Pub/Sub subscriber that receives trace messages, writes them
 * to the store, and only acknowledges AFTER successful DB write.
 */
export class PubSubTraceConsumer {
  private readonly store: ITraceStore;
  private readonly subscriptionName: string;
  private readonly projectId?: string;
  private readonly onInsert?: (traces: Trace[]) => void;

  private subscription?: Subscription;

  constructor(options: PubSubTraceConsumerOptions) {
    this.store = options.store;
    this.subscriptionName =
      options.subscriptionName ?? "lantern-traces-subscription";
    this.projectId = options.projectId;
    this.onInsert = options.onInsert;
  }

  /**
   * Subscribe to the Pub/Sub subscription and begin processing messages.
   */
  start(): void {
    const pubsub = new PubSub({ projectId: this.projectId });
    this.subscription = pubsub.subscription(this.subscriptionName);

    this.subscription.on("message", (message: Message) => {
      this.handleMessage(message);
    });

    this.subscription.on("error", (error: Error) => {
      console.error("[PubSubTraceConsumer] subscription error:", error);
    });
  }

  /**
   * Handle a single Pub/Sub message. Public for direct testing
   * without a real Pub/Sub connection.
   */
  async handleMessage(message: Message): Promise<void> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(message.data.toString("utf-8"));
    } catch {
      message.nack();
      return;
    }

    const payload = parsed as { traces?: unknown };

    if (!Array.isArray(payload.traces)) {
      message.nack();
      return;
    }

    const traces: Trace[] = payload.traces;

    // Empty array is valid — ack without inserting
    if (traces.length === 0) {
      message.ack();
      return;
    }

    try {
      await this.store.insert(traces);
      message.ack();
      this.onInsert?.(traces);
    } catch {
      message.nack();
    }
  }

  /**
   * Remove listeners and close the subscription.
   */
  async shutdown(): Promise<void> {
    if (this.subscription) {
      this.subscription.removeAllListeners();
      await this.subscription.close();
      this.subscription = undefined;
    }
  }
}
