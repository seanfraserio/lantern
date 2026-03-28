import { CloudTasksClient } from "@google-cloud/tasks";

export interface EvalJob {
  traceId: string;
  agentName: string;
  tenantSchema?: string;
}

export interface EvalTriggerConfig {
  projectId: string;
  location: string;
  queue: string;
  workerUrl: string;
}

/**
 * Creates Cloud Tasks HTTP jobs that trigger the evaluation worker
 * after trace ingestion. Each job targets a single trace for evaluation.
 */
export class EvalTrigger {
  private readonly client: CloudTasksClient;
  private readonly config: EvalTriggerConfig;

  constructor(config: EvalTriggerConfig) {
    this.config = config;
    this.client = new CloudTasksClient();
  }

  /**
   * Enqueue evaluation jobs as Cloud Tasks. Individual task creation
   * failures are logged but do not throw — one bad task should not
   * prevent the rest of the batch from being enqueued.
   */
  async enqueue(jobs: EvalJob[]): Promise<void> {
    if (jobs.length === 0) return;

    const queuePath = this.client.queuePath(
      this.config.projectId,
      this.config.location,
      this.config.queue
    );

    for (const job of jobs) {
      try {
        const payload: Record<string, string> = {
          traceId: job.traceId,
          agentName: job.agentName,
        };

        if (job.tenantSchema !== undefined) {
          payload.tenantSchema = job.tenantSchema;
        }

        await this.client.createTask({
          parent: queuePath,
          task: {
            httpRequest: {
              httpMethod: "POST" as const,
              url: this.config.workerUrl,
              headers: { "Content-Type": "application/json" },
              body: Buffer.from(JSON.stringify(payload)).toString("base64"),
            },
          },
        });
      } catch (error) {
        console.error(
          `[EvalTrigger] failed to enqueue task for trace ${job.traceId}:`,
          error
        );
      }
    }
  }
}
