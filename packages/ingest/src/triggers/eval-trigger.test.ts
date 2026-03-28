import { describe, it, expect, vi, beforeEach } from "vitest";
import { EvalTrigger } from "./eval-trigger.js";
import type { EvalJob, EvalTriggerConfig } from "./eval-trigger.js";

const mockCreateTask = vi.fn().mockResolvedValue([{ name: "task-id" }]);
const mockQueuePath = vi
  .fn()
  .mockReturnValue("projects/p/locations/l/queues/q");

vi.mock("@google-cloud/tasks", () => ({
  CloudTasksClient: vi.fn().mockImplementation(() => ({
    createTask: mockCreateTask,
    queuePath: mockQueuePath,
  })),
}));

const defaultConfig: EvalTriggerConfig = {
  projectId: "my-project",
  location: "us-central1",
  queue: "eval-queue",
  workerUrl: "https://eval-worker.example.com/run",
};

describe("EvalTrigger", () => {
  let trigger: EvalTrigger;

  beforeEach(() => {
    vi.clearAllMocks();
    trigger = new EvalTrigger(defaultConfig);
  });

  it("creates a Cloud Task for each job in the array", async () => {
    const jobs: EvalJob[] = [
      { traceId: "trace-1", agentName: "agent-a" },
      { traceId: "trace-2", agentName: "agent-b" },
      { traceId: "trace-3", agentName: "agent-c" },
    ];

    await trigger.enqueue(jobs);

    expect(mockCreateTask).toHaveBeenCalledTimes(3);
  });

  it("task body contains traceId and agentName", async () => {
    const jobs: EvalJob[] = [
      { traceId: "trace-42", agentName: "my-agent", tenantSchema: "tenant_1" },
    ];

    await trigger.enqueue(jobs);

    expect(mockCreateTask).toHaveBeenCalledTimes(1);

    const call = mockCreateTask.mock.calls[0][0];
    const body = JSON.parse(
      Buffer.from(call.task.httpRequest.body, "base64").toString()
    );

    expect(body).toEqual({
      traceId: "trace-42",
      agentName: "my-agent",
      tenantSchema: "tenant_1",
    });
  });

  it("does not throw when individual task creation fails (logs error, continues)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockCreateTask
      .mockResolvedValueOnce([{ name: "task-1" }])
      .mockRejectedValueOnce(new Error("Cloud Tasks API error"))
      .mockResolvedValueOnce([{ name: "task-3" }]);

    const jobs: EvalJob[] = [
      { traceId: "t1", agentName: "a1" },
      { traceId: "t2", agentName: "a2" },
      { traceId: "t3", agentName: "a3" },
    ];

    // Should not throw
    await expect(trigger.enqueue(jobs)).resolves.toBeUndefined();

    // All three attempts were made
    expect(mockCreateTask).toHaveBeenCalledTimes(3);

    // Error was logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[EvalTrigger]"),
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });

  it("uses correct queue path", async () => {
    const jobs: EvalJob[] = [{ traceId: "t1", agentName: "a1" }];

    await trigger.enqueue(jobs);

    expect(mockQueuePath).toHaveBeenCalledWith(
      "my-project",
      "us-central1",
      "eval-queue"
    );

    const call = mockCreateTask.mock.calls[0][0];
    expect(call.parent).toBe("projects/p/locations/l/queues/q");
  });

  it("sends POST request with correct headers and URL", async () => {
    const jobs: EvalJob[] = [{ traceId: "t1", agentName: "a1" }];

    await trigger.enqueue(jobs);

    const call = mockCreateTask.mock.calls[0][0];
    expect(call.task.httpRequest.httpMethod).toBe("POST");
    expect(call.task.httpRequest.url).toBe(
      "https://eval-worker.example.com/run"
    );
    expect(call.task.httpRequest.headers["Content-Type"]).toBe(
      "application/json"
    );
  });

  it("handles empty jobs array without calling createTask", async () => {
    await trigger.enqueue([]);

    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("omits tenantSchema from body when not provided", async () => {
    const jobs: EvalJob[] = [{ traceId: "t1", agentName: "a1" }];

    await trigger.enqueue(jobs);

    const call = mockCreateTask.mock.calls[0][0];
    const body = JSON.parse(
      Buffer.from(call.task.httpRequest.body, "base64").toString()
    );

    expect(body).toEqual({ traceId: "t1", agentName: "a1" });
    expect(body).not.toHaveProperty("tenantSchema");
  });
});
