import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createServer } from "../server.js";

describe("single-tenant API key configuration precedence", () => {
  let directory: string;
  let app: FastifyInstance | undefined;
  const listen = vi.fn(async () => {});

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "lantern-key-precedence-"));
    listen.mockClear();
    vi.stubEnv("LANTERN_API_KEY", "");
    vi.stubEnv("MULTI_TENANT", "false");
    vi.stubEnv("LANTERN_ALLOW_INSECURE", "false");
    vi.stubEnv("PROMPT_DB_PATH", ":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function options(keys = ["", "yaml-test-key"]) {
    const configPath = join(directory, "lantern.yaml");
    writeFileSync(configPath, `version: "1"\nserver:\n  log_level: silent\nauth:\n  enabled: true\n  api_keys: ${JSON.stringify(keys)}\n`);
    return { configPath, port: 0, host: "0.0.0.0", dbPath: ":memory:", listen };
  }

  async function status(key?: string) {
    const response = await app!.inject({
      method: "GET",
      url: "/v1/traces",
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    return response.statusCode;
  }

  it("uses the first nonempty YAML key when the environment key is empty", async () => {
    app = (await createServer(options())).app;
    expect(listen).toHaveBeenCalledOnce();
    expect(await status("yaml-test-key")).toBe(200);
    expect(await status()).toBe(401);
    expect(await status("incorrect-key")).toBe(401);
  });

  it("uses the YAML key when the environment variable is absent", async () => {
    vi.stubEnv("LANTERN_API_KEY", undefined);
    app = (await createServer(options())).app;
    expect(await status("yaml-test-key")).toBe(200);
    expect(await status()).toBe(401);
  });

  it("prefers a nonempty environment key over YAML", async () => {
    vi.stubEnv("LANTERN_API_KEY", "environment-test-key");
    app = (await createServer(options())).app;
    expect(await status("environment-test-key")).toBe(200);
    expect(await status("yaml-test-key")).toBe(401);
  });

  it("prefers an explicit configuration key over the environment", async () => {
    vi.stubEnv("LANTERN_API_KEY", "environment-test-key");
    app = (await createServer({ ...options(), apiKey: "explicit-test-key" })).app;
    expect(await status("explicit-test-key")).toBe(200);
    expect(await status("environment-test-key")).toBe(401);
    expect(await status("yaml-test-key")).toBe(401);
  });

  it("still rejects a nonlocal bind when environment and YAML keys are empty", async () => {
    await expect(createServer(options([""]))).rejects.toThrow(/API key/i);
    expect(listen).not.toHaveBeenCalled();
  });

  it("does not replace an explicitly empty configuration key with a fallback", async () => {
    await expect(createServer({ ...options(), apiKey: "" })).rejects.toThrow(/API key/i);
    expect(listen).not.toHaveBeenCalled();
  });
});
